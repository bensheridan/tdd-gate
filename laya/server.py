"""Laya behind the /v1/systemone protocol, set up for tdd-gate.

`laya.serve` already speaks TypeSafe's wire format; this adds what tdd-gate needs on top:

- every request goes to one checkpoint (LAYA_MODEL, default multilingual), never auto-routed;
- the token budget is raised to LAYA_MAX_LEN (default 8192, mmBERT's context) from the
  checkpoint's trained 1024, because Laya otherwise cuts the state silently;
- a request that would still be cut is refused (HTTP 422), so tdd-gate reports it as not judged
  instead of judging a test or hunk it only saw part of.

    pip install "laya[serve]"
    python laya/server.py            # then: tdd-gate <command> --backend laya
"""
import json
import os

from laya.common import render_options, serialize_state
from laya.router import Router
from laya.serve import create_app

MODEL = os.environ.get("LAYA_MODEL", "multilingual")
MAX_LEN = int(os.environ.get("LAYA_MAX_LEN", "8192"))
HEAD_MAX_LEN = 256
OPTION_CAP = 48  # tokens per option, as in laya.common.build_sequence


def cut_questions(tok, state, questions):
    """Ids of the questions whose instructions, options or state would not fit whole."""
    state_len = len(tok(serialize_state(state).replace(tok.mask_token, " "), add_special_tokens=False)["input_ids"])
    cut = []
    for qid, q in questions.items():
        ins = q.get("instructions")
        ins = ins if isinstance(ins, str) else json.dumps(ins, ensure_ascii=False)
        head = len(tok("%s question: %s" % (q.get("type"), ins), add_special_tokens=False)["input_ids"])
        crit = q.get("criteria")
        if q.get("type") == "choice" and isinstance(crit, list):
            crit = {c: None for c in crit}
        options = render_options({"t": q.get("type"), "crit": crit})
        option_lens = [len(tok(" " + o, add_special_tokens=False)["input_ids"]) for o in options]
        opts = sum(1 + min(OPTION_CAP, n) for n in option_lens)
        # [CLS] head [SEP] options [SEP] state [SEP]
        if any(n > OPTION_CAP for n in option_lens) or head + opts > HEAD_MAX_LEN or 1 + head + 1 + opts + 1 + state_len + 1 > MAX_LEN:
            cut.append(qid)
    return cut


class TddGateRouter(Router):
    def predict(self, state, questions, model=None, **kwargs):
        agent = self.load(MODEL)
        cut = cut_questions(agent.tok, state, questions)
        if cut:
            raise ValueError(
                "input does not fit Laya's token budget (max_len %d, head %d) for question(s) %s; not judged"
                % (MAX_LEN, HEAD_MAX_LEN, ", ".join(cut))
            )
        return super().predict(state, questions, model=MODEL, max_len=MAX_LEN, head_max_len=HEAD_MAX_LEN, **kwargs)


def main():
    import uvicorn

    router = TddGateRouter(device=os.environ.get("LAYA_DEVICE") or None)
    router.preload([MODEL])
    uvicorn.run(
        create_app(router),
        host=os.environ.get("LAYA_HOST", "127.0.0.1"),
        port=int(os.environ.get("LAYA_PORT", "8000")),
        log_level=os.environ.get("LAYA_LOG_LEVEL", "warning"),
    )


if __name__ == "__main__":
    main()
