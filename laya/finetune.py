"""Fine-tune Laya to answer tdd-gate's questions the way Jev does.

Training data is a request log (`tdd-gate eval --log-requests <file>` against Jev): every state,
the exact questions, and Jev's probabilities. Each question is one row; its target is Jev's
distribution over the options ([1-p, p] for a noul, the per-option probabilities for a choice), and
the loss is cross-entropy against it. Requests that appear more than once (repeated runs) are
merged by averaging, which smooths Jev's run-to-run noise.

Rows are split by plan, never at random: cases within a plan share code and requirements, so a
random split would leak. `--holdout` plans are left out of training entirely and reported on at the
end; a slice of the training cases is kept back to fit the temperatures and watch for overfitting.

    python laya/finetune.py --log jev-requests.jsonl --holdout cart --out checkpoints/laya-no-cart
    LAYA_CHECKPOINT=checkpoints/laya-no-cart python laya/server.py
    node dist/cli.js eval --cases eval/cases/cart --backend laya

Uses Laya internals (Agent._encode_state, collate_items, the model's forward); pin laya==0.3.20.
"""
import argparse
import glob
import json
import math
import os
import random
import shutil
import sys
import time
from collections import defaultdict

import numpy as np
import torch
import torch.nn.functional as F

import laya
from laya.common import QTYPES, collate_items

HEAD_MAX_LEN = 256


def case_plans(cases_dir):
    """caseId -> plan, from the case files, for log lines written before `plan` was logged."""
    plans = {}
    for path in glob.glob(os.path.join(cases_dir, "**", "*.json"), recursive=True):
        with open(path) as f:
            c = json.load(f)
        if "id" in c:
            plans[c["id"]] = (c.get("meta") or {}).get("plan") or os.path.relpath(path, cases_dir).split(os.sep)[0]
    return plans


def target_of(question, answer):
    """Jev's distribution over the options, in the order Laya renders them; None if unusable."""
    if question["type"] == "noul" and answer.get("type") == "noul":
        p = float(answer["noul"])
        return [1.0 - p, p]  # Laya's noul options are [false, true]
    if question["type"] == "choice" and answer.get("type") == "choice":
        keys = list(question["criteria"].keys())
        probs = answer.get("probabilities") or {}
        t = [float(probs.get(k, 0.0)) for k in keys]
        if sum(t) <= 0:
            if answer.get("choice") not in keys:
                return None
            t = [1.0 if k == answer["choice"] else 0.0 for k in keys]
        s = sum(t)
        return [x / s for x in t]
    return None


def load_requests(log_path, plans):
    """Merged requests: {key: {plan, caseId, state, questions, targets: {qid: [lists]}}}."""
    merged = {}
    skipped = 0
    with open(log_path) as f:
        for line in f:
            r = json.loads(line)
            if "error" in r or "answers" not in r:
                skipped += 1
                continue
            case_id = r.get("caseId", "")
            plan = r.get("plan") or plans.get(case_id)
            if not plan:
                skipped += 1
                continue
            key = json.dumps([case_id, r["state"], r["questions"]], sort_keys=True)
            m = merged.setdefault(key, {"plan": plan, "caseId": case_id, "state": r["state"],
                                        "questions": r["questions"], "targets": defaultdict(list)})
            for qid, q in r["questions"].items():
                t = target_of(q, r["answers"].get(qid, {}))
                if t is not None:
                    m["targets"][qid].append(t)
    return list(merged.values()), skipped


def encode(agent, requests, max_len):
    """One item per question, carrying its averaged target. Requests that do not fit are dropped."""
    items, dropped = [], 0
    for r in requests:
        ids = [qid for qid in r["questions"] if r["targets"].get(qid)]
        if not ids:
            continue
        for qid in ids:
            agent._check_question(qid, r["questions"][qid])
        internal = {qid: agent._to_internal(r["questions"][qid]) for qid in ids}
        # Encoded without a limit, so a request that would be cut is seen whole and dropped:
        # do not teach the model answers from input it could not see.
        encoded = agent._encode_state(r["state"], ids, internal, max_len=10**6, head_max_len=HEAD_MAX_LEN)
        if max(len(it["ids"]) for it in encoded) > max_len:
            dropped += 1
            continue
        for qid, it in zip(ids, encoded):
            target = np.mean(np.array(r["targets"][qid]), axis=0).tolist()
            if len(target) != len(it["markers"]):
                continue
            items.append({**it, "target": target, "caseId": r["caseId"], "plan": r["plan"], "qid": qid})
    return items, dropped


def batches(items, rows, shuffle, max_tokens=8192):
    """Length-bucketed batches of up to `rows` items and `max_tokens` padded tokens, so a batch of
    long inputs is smaller instead of running out of (MPS) memory."""
    order = sorted(range(len(items)), key=lambda i: len(items[i]["ids"]))
    groups, group = [], []
    for i in order:
        width = len(items[i]["ids"])  # the longest so far, since the order is ascending
        if group and (len(group) >= rows or (len(group) + 1) * width > max_tokens):
            groups.append(group)
            group = []
        group.append(i)
    if group:
        groups.append(group)
    if shuffle:
        random.shuffle(groups)
    for g in groups:
        yield [items[i] for i in g]


def forward(agent, group):
    b = collate_items([[{k: it[k] for k in ("ids", "markers", "qtype", "target")} for it in group]], agent.tok.pad_token_id)
    dev = agent.device
    logits, _ = agent.model(b["input_ids"].to(dev), b["attention_mask"].to(dev), b["marker_pos"].to(dev),
                            b["marker_mask"].to(dev), b["qtype"].to(dev))
    return logits, b["target"].to(dev), b["marker_mask"].to(dev)


def soft_ce(logits, target, mask, temperature=1.0):
    logp = F.log_softmax((logits / temperature).masked_fill(~mask, -1e4), -1)
    return -(target * logp).sum(-1)


@torch.no_grad()
def predict(agent, items, rows, max_tokens=8192):
    """Raw logits per item (in item order), for evaluation and temperature fitting."""
    agent.model.eval()
    out = [None] * len(items)
    index = {id(it): i for i, it in enumerate(items)}
    for group in batches(items, rows, shuffle=False, max_tokens=max_tokens):
        logits, _, mask = forward(agent, group)
        for it, row, m in zip(group, logits.float().cpu(), mask.cpu()):
            out[index[id(it)]] = row[m].numpy()
    return out


def fit_temperature(logits, targets):
    """The temperature (Laya's clamp range, 0.5 to 5) that minimises cross-entropy to the targets."""
    best, best_t = float("inf"), 1.0
    for t in np.exp(np.linspace(math.log(0.5), math.log(5.0), 60)):
        loss = 0.0
        for z, y in zip(logits, targets):
            z = z / t
            z = z - z.max()
            loss -= float(np.dot(y, z - np.log(np.exp(z).sum())))
        if loss < best:
            best, best_t = loss, float(t)
    return best_t


def auc(scores, labels):
    """Probability that a random positive scores above a random negative (ties count half)."""
    scores, labels = np.asarray(scores), np.asarray(labels, dtype=bool)
    pos, neg = labels.sum(), (~labels).sum()
    if not pos or not neg:
        return float("nan")
    ranks = np.empty(len(scores))
    order = scores.argsort(kind="mergesort")
    ranks[order] = np.arange(1, len(scores) + 1)
    for v in np.unique(scores):  # average ranks over ties
        tie = scores == v
        ranks[tie] = ranks[tie].mean()
    return float((ranks[labels].sum() - pos * (pos + 1) / 2) / (pos * neg))


def report(name, items, logits, temps):
    """Agreement with Jev: mean |p - p_jev| and yes/no agreement for nouls, top-option agreement for choices."""
    by_type = defaultdict(list)
    for it, z in zip(items, logits):
        t = temps.get(it["qtype"], 1.0)
        p = np.exp(z / t - (z / t).max())
        p = p / p.sum()
        by_type[it["qtype"]].append((p, np.array(it["target"])))
    parts = []
    for qt, rows in sorted(by_type.items()):
        if qt == QTYPES["noul"]:
            diff = np.mean([abs(p[1] - y[1]) for p, y in rows])
            agree = np.mean([(p[1] >= 0.5) == (y[1] >= 0.5) for p, y in rows])
            yes = np.mean([y[1] >= 0.5 for _, y in rows])
            # Jev mostly says no, so agreement alone rewards saying no; AUC is whether Laya ranks
            # Jev's yeses above its nos, which is what a threshold needs.
            parts.append(f"noul n={len(rows)} mean|p-jev|={diff:.3f} agree@0.5={agree:.1%} "
                         f"(always-no {1 - yes:.1%}) AUC-vs-jev={auc([p[1] for p, _ in rows], [y[1] >= 0.5 for _, y in rows]):.3f}")
        else:
            agree = np.mean([p.argmax() == y.argmax() for p, y in rows])
            parts.append(f"choice n={len(rows)} top-agree={agree:.1%}")
    print(f"  {name:10} " + "; ".join(parts), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--log", required=True, help="JSONL request log from `tdd-gate eval --log-requests`")
    ap.add_argument("--cases", default="eval/cases", help="case files, to find the plan of old log lines")
    ap.add_argument("--holdout", action="append", default=[], help="plan left out of training (repeatable)")
    ap.add_argument("--out", required=True, help="directory to write the checkpoint to")
    ap.add_argument("--base", default="multilingual", help="Laya checkpoint to start from")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=2e-5, help="encoder learning rate")
    ap.add_argument("--head-lr", type=float, default=1e-4)
    ap.add_argument("--rows", type=int, default=16, help="questions per batch")
    ap.add_argument("--max-len", type=int, default=2048, help="longest input kept for training, in tokens")
    ap.add_argument("--max-tokens", type=int, default=8192, help="padded tokens per batch")
    ap.add_argument("--val-fraction", type=float, default=0.1, help="training cases kept back for temperatures")
    ap.add_argument("--limit", type=int, default=0, help="train on at most this many rows (smoke tests)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()
    random.seed(args.seed)
    torch.manual_seed(args.seed)

    requests, skipped = load_requests(args.log, case_plans(args.cases))
    plans = sorted({r["plan"] for r in requests})
    unknown = [p for p in args.holdout if p not in plans]
    if unknown:
        sys.exit(f"unknown --holdout plan(s) {unknown}; the log has {plans}")
    print(f"{len(requests)} distinct requests over plans {plans} ({skipped} log lines skipped)", flush=True)

    router = laya.Router(device=args.device, preload=False)
    agent = router.load(args.base)
    items, dropped = encode(agent, requests, args.max_len)
    print(f"{len(items)} question rows; {dropped} request(s) dropped as longer than --max-len {args.max_len}", flush=True)

    held = [it for it in items if it["plan"] in args.holdout]
    rest = [it for it in items if it["plan"] not in args.holdout]
    case_ids = sorted({it["caseId"] for it in rest})
    random.shuffle(case_ids)
    val_ids = set(case_ids[: max(1, int(len(case_ids) * args.val_fraction))])
    val = [it for it in rest if it["caseId"] in val_ids]
    train = [it for it in rest if it["caseId"] not in val_ids]
    if args.limit:
        random.shuffle(train)
        train = train[: args.limit]
    print(f"train {len(train)} rows / val {len(val)} rows ({len(val_ids)} cases) / held-out {len(held)} rows "
          f"({', '.join(args.holdout) or 'none'})", flush=True)

    print("before fine-tuning (agreement with Jev):", flush=True)
    for name, part in (("val", val), ("held-out", held)):
        if part:
            report(name, part, predict(agent, part, args.rows), {})

    model = agent.model
    enc_params = list(model.encoder.parameters())
    enc_ids = {id(p) for p in enc_params}
    head_params = [p for p in model.parameters() if id(p) not in enc_ids]
    opt = torch.optim.AdamW([{"params": enc_params, "lr": args.lr}, {"params": head_params, "lr": args.head_lr}], weight_decay=0.01)
    steps = args.epochs * sum(1 for _ in batches(train, args.rows, shuffle=False, max_tokens=args.max_tokens))
    warmup = max(1, steps // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warmup) * max(0.0, (steps - s) / max(1, steps - warmup)))
    # Recompute activations in the backward pass, in the encoder and in Laya's own head layers.
    if hasattr(model.encoder, "gradient_checkpointing_enable"):
        model.encoder.gradient_checkpointing_enable()
    model.head_checkpointing = True

    step, started = 0, time.time()
    for epoch in range(args.epochs):
        model.train()
        total, n = 0.0, 0
        for group in batches(train, args.rows, shuffle=True, max_tokens=args.max_tokens):
            logits, target, mask = forward(agent, group)
            loss = soft_ce(logits, target, mask).mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            total, n = total + loss.item() * len(group), n + len(group)
            if step % 50 == 0:
                print(f"  epoch {epoch + 1} step {step}/{steps} loss {total / n:.4f} ({time.time() - started:.0f}s)", flush=True)
        print(f"epoch {epoch + 1}: train loss {total / max(1, n):.4f}", flush=True)
        if val:
            report("val", val, predict(agent, val, args.rows), {})

    # Temperatures per question type, fitted on the validation cases, as Laya applies them.
    temps = {}
    if val:
        val_logits = predict(agent, val, args.rows)
        for qt in sorted({it["qtype"] for it in val}):
            sel = [(z, np.array(it["target"])) for z, it in zip(val_logits, val) if it["qtype"] == qt]
            temps[qt] = fit_temperature([z for z, _ in sel], [y for _, y in sel])
        print(f"temperatures: { {k: round(v, 3) for k, v in temps.items()} }", flush=True)

    print("after fine-tuning (agreement with Jev):", flush=True)
    for name, part in (("val", val), ("held-out", held)):
        if part:
            report(name, part, predict(agent, part, args.rows), temps)

    save(agent, args, temps, {"train_rows": len(train), "val_rows": len(val), "holdout": args.holdout,
                              "plans": plans, "steps": step, "seconds": round(time.time() - started)})


def save(agent, args, temps, stats):
    from safetensors.torch import save_file

    from huggingface_hub import snapshot_download

    # The base checkpoint's tokenizer and encoder config travel with the new weights (already cached).
    repo, sub = laya.DEFAULT_MODELS[args.base]
    src = os.path.join(snapshot_download(repo, allow_patterns=[f"{sub}/*" if sub else "*"]), sub or "")
    os.makedirs(args.out, exist_ok=True)
    for sub in ("tokenizer", "encoder"):
        if os.path.isdir(os.path.join(src, sub)):
            shutil.copytree(os.path.join(src, sub), os.path.join(args.out, sub), dirs_exist_ok=True)
    state = {k: v.detach().to("cpu").contiguous() for k, v in agent.model.state_dict().items()}
    save_file(state, os.path.join(args.out, "model.safetensors"))
    cfg = dict(agent.cfg)
    cfg["temperature"] = [temps.get(i, cfg.get("temperature", [1.0, 1.0, 1.0])[i]) for i in range(3)]
    cfg["temperature_by_options"] = {}
    cfg["training"] = {**cfg.get("training", {}), "fine_tuned_from_checkpoint": True, "tdd_gate": {
        "base": args.base, "log": os.path.basename(args.log), "epochs": args.epochs, "lr": args.lr,
        "head_lr": args.head_lr, "max_len": args.max_len, "seed": args.seed, **stats}}
    with open(os.path.join(args.out, "rl_agent_config.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"checkpoint written to {args.out}", flush=True)


if __name__ == "__main__":
    main()
