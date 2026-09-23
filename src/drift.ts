import { noul, type Questions } from "@typesafe-ai/sdk";
import { ask, emptyUsage, errorText, mapPool, noulOf, type SystemOneCaller, type Usage } from "./client.js";
import { gateHunks, type DiffFinding, type DiffGateResult } from "./diffgates.js";
import type { Plan, Requirement } from "./requirements.js";

/**
 * drift: code the code agent added that the plan does not ask for. Per hunk of non-test code, one
 * request asks three kinds of question:
 *
 *   need_i        is the hunk needed by requirement i? (gives the hunk -> requirement trace)
 *   extra         does it add behaviour that no requirement asks for? (catches scope creep inside
 *                 a hunk that also does needed work, which the per-requirement nouls cannot)
 *   housekeeping  is it only formatting, renaming, moving, imports, comments or types?
 */

const NEED_TASK =
    "`hunk` is part of a change to the code. Decide whether the lines ADDED in `hunk` (marked '+') implement, or directly support, " +
    "the behaviour in `requirement`. Direct support includes helpers, types, imports and input handling that this behaviour uses. " +
    "Code that is only in the same file or function but does something else does NOT count.";

const EXTRA_TASK =
    "Decide whether the lines ADDED in `hunk` (marked '+') add a behaviour that none of the requirements in `requirements` asks for: " +
    "for example caching, a new option or parameter, logging or analytics, a new public function, endpoint or command, or handling " +
    "of cases the requirements do not mention. Helpers, types, imports and exports, and validation or error handling that serve a " +
    "listed requirement do NOT count. Lines marked '-' were removed and lines marked ' ' are unchanged context: do not judge them.";

const HOUSEKEEPING_TASK =
    "Decide whether the change in `hunk` only reorganises code without changing what it does: formatting, renaming, moving code, " +
    "imports or exports, comments, or type annotations.";

const needKey = (i: number) => `need_${i}`;

export function buildDriftQuestions(requirements: Requirement[]): Questions {
    const questions: Questions = {
        extra: noul(EXTRA_TASK, {
            true: "The added lines do something no listed requirement asks for.",
            false: "Everything the added lines do serves a listed requirement, or supports one.",
        }),
        housekeeping: noul(HOUSEKEEPING_TASK, {
            true: "The change does not alter behaviour.",
            false: "The change alters what the code does.",
        }),
    };
    requirements.forEach((r, i) => {
        questions[needKey(i)] = noul(
            { task: NEED_TASK, requirement: r.text },
            { true: "The added lines implement or directly support this behaviour.", false: "The added lines are about something else." }
        );
    });
    return questions;
}

export async function checkDrift(
    client: SystemOneCaller,
    diff: string,
    plan: Plan,
    options: { concurrency?: number } = {}
): Promise<DiffGateResult> {
    const { requirements, thresholds } = plan;
    const usage: Usage = emptyUsage();
    const hunks = gateHunks("drift", diff).filter((h) => h.addedLines.length > 0);
    const questions = buildDriftQuestions(requirements);
    const requirementTexts = requirements.map((r) => r.text);

    const outcomes = await mapPool(hunks, options.concurrency ?? 4, async (hunk) => {
        try {
            const answers = await ask(client, usage, { file: hunk.file, hunk: hunk.text, requirements: requirementTexts }, questions);
            return {
                hunk,
                extra: noulOf(answers, "extra"),
                housekeeping: noulOf(answers, "housekeeping"),
                needs: requirements.map((r, i) => ({ id: r.id, p: noulOf(answers, needKey(i)) })),
                error: null as string | null,
            };
        } catch (err) {
            return { hunk, extra: 0, housekeeping: 0, needs: [], error: errorText(err) };
        }
    });

    const findings: DiffFinding[] = [];
    const failures: DiffGateResult["failures"] = [];
    const trace: NonNullable<DiffGateResult["trace"]> = [];
    for (const o of outcomes) {
        const { hunk } = o;
        if (o.error) {
            failures.push({ file: hunk.file, startLine: hunk.startLine, error: o.error });
            continue;
        }
        const served = o.needs.filter((n) => n.p >= thresholds.covered).sort((a, b) => b.p - a.p);
        trace.push({ file: hunk.file, startLine: hunk.startLine, endLine: hunk.endLine, requirements: served.map((n) => n.id) });
        const at = { gate: "drift" as const, file: hunk.file, startLine: hunk.startLine, endLine: hunk.endLine };

        // A change that only reorganises code adds no behaviour, whatever else it touches.
        const reorganises = o.housekeeping >= thresholds.flag;
        if (o.extra >= thresholds.possible && !reorganises) {
            const band = o.extra >= thresholds.flag ? "violation" : "possible";
            findings.push({
                ...at,
                ruleId: "unrequested-behaviour",
                title: "Behaviour no requirement asks for",
                severity: "error",
                probability: o.extra,
                band,
                route: band === "violation" ? "code-agent" : "human",
                message:
                    `Adds behaviour no requirement asks for (p=${o.extra.toFixed(2)}): remove it, or add the requirement to the plan` +
                    (served.length ? ` (the hunk also serves ${served.map((n) => n.id).join(", ")})` : ""),
            });
            continue;
        }
        const best = Math.max(0, ...o.needs.map((n) => n.p));
        // Weak signal, so any real chance of housekeeping (re-exports, moved code) exempts it.
        if (best < thresholds.possible && o.housekeeping < thresholds.possible) {
            // Nothing extra was seen, but nothing needs it either: dead code, or a requirement the
            // plan is missing. A person decides.
            findings.push({
                ...at,
                ruleId: "untraced",
                title: "No requirement needs this change",
                severity: "warning",
                probability: 1 - best,
                band: "violation",
                route: "human",
                message: `No requirement needs this change (best p(needed)=${best.toFixed(2)})`,
            });
        }
    }
    findings.sort((a, b) => b.probability - a.probability);

    const judged = outcomes.filter((o) => !o.error).map((o) => o.hunk);
    return {
        gate: "drift",
        findings,
        failures,
        truncated: judged.filter((h) => h.truncated).map((h) => ({ file: h.file, startLine: h.startLine })),
        stats: { hunks: hunks.length, hunksJudged: judged.length, skipped: 0 },
        usage,
        trace,
    };
}
