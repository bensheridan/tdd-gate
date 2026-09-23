import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlameResult, Verdict } from "./blame.js";
import type { CoverageResult, Route, Status } from "./coverage.js";
import type { DiffGateResult } from "./diffgates.js";
import type { TestFailure } from "./junit.js";
import type { Gates } from "./orchestrate.js";
import type { Plan } from "./requirements.js";
import type { TestCase } from "./tests.js";

/**
 * An eval case is one gate decision with everything needed to make it again: the plan, the exact
 * inputs, what the gate said when the case was recorded, and (if known) what it should have said.
 *
 * Label sources, reported separately because they deserve different trust:
 *   construction  an agent was asked for a specific change (a bug in requirement R, a skipped test)
 *                 and the result was checked mechanically; the label follows from the request
 *   review        a person looked at the case and wrote the label
 *   unlabeled     recorded from a run; nobody has judged it yet (listed by eval, never scored)
 */
export type LabelSource = "construction" | "review" | "unlabeled";

export type CaseInput =
    | { gate: "coverage"; tests: TestCase[] }
    | { gate: "blame"; failures: TestFailure[]; tests: TestCase[]; codeDiff: string }
    | { gate: "gaming"; diff: string; tests: TestCase[] }
    | { gate: "weakening"; diff: string }
    | { gate: "drift"; diff: string };

export type GateName = CaseInput["gate"];
export type GateResult = CoverageResult | BlameResult | DiffGateResult;

/** What the gate should say. Only what is listed is scored; anything else about the case is not asserted. */
export interface Expect {
    /** Diff gates: rule ids that should be flagged (violation band). Every other rule of the gate should not be. */
    flagged?: string[];
    /** Coverage: requirement ids some test should conflict with. */
    conflicts?: string[];
    /** Coverage: requirement ids no test should conflict with. */
    noConflicts?: string[];
    /** Coverage: expected status per requirement id. */
    statuses?: Record<string, Status>;
    /** Blame: expected route for every failure in the case. */
    route?: Route;
    /** Blame: expected verdict for every failure (optional, stricter than route). */
    verdict?: Verdict;
}

export interface EvalCase {
    id: string;
    /** How the case was made: "run" for a natural turn, or the harvest kind ("code-bug", "skip-test", ...). */
    kind: string;
    plan: Plan;
    input: CaseInput;
    expect: Expect;
    labelSource: LabelSource;
    /** The gate's output when the case was recorded. Eval re-runs the gate; this is for comparison. */
    recorded?: GateResult;
    /** Free-form provenance: plan name, requirement, agent command, what was asked. */
    meta: Record<string, string>;
}

export function judge(gates: Gates, input: CaseInput): Promise<GateResult> {
    switch (input.gate) {
        case "coverage":
            return gates.coverage(input.tests);
        case "blame":
            return gates.blame(input.failures, input.tests, input.codeDiff);
        case "gaming":
            return gates.gaming(input.diff, input.tests);
        case "weakening":
            return gates.weakening(input.diff);
        case "drift":
            return gates.drift(input.diff);
    }
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]+/g, "_");

export function saveCase(dir: string, c: EvalCase): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safe(c.id)}.json`);
    writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
    return path;
}

export function loadCases(dir: string): EvalCase[] {
    const out: EvalCase[] = [];
    const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(join(d, e.name));
            else if (e.name.endsWith(".json")) {
                const c = JSON.parse(readFileSync(join(d, e.name), "utf8")) as EvalCase;
                if (c && c.id && c.input && c.plan) out.push(c);
            }
        }
    };
    walk(dir);
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Wraps gates so every decision in a run is also saved as an unlabeled case. */
export function recordingGates(gates: Gates, plan: Plan, sink: (c: EvalCase) => void, prefix: string, meta: Record<string, string> = {}): Gates {
    let n = 0;
    const record = async (input: CaseInput): Promise<GateResult> => {
        const result = await judge(gates, input);
        n++;
        sink({
            id: `${prefix}/${String(n).padStart(3, "0")}-${input.gate}`,
            kind: "run",
            plan,
            input,
            expect: {},
            labelSource: "unlabeled",
            recorded: result,
            meta,
        });
        return result;
    };
    return {
        coverage: (tests) => record({ gate: "coverage", tests }) as Promise<CoverageResult>,
        blame: (failures, tests, codeDiff) => record({ gate: "blame", failures, tests, codeDiff }) as Promise<BlameResult>,
        gaming: (diff, tests) => record({ gate: "gaming", diff, tests }) as Promise<DiffGateResult>,
        weakening: (diff) => record({ gate: "weakening", diff }) as Promise<DiffGateResult>,
        drift: (diff) => record({ gate: "drift", diff }) as Promise<DiffGateResult>,
    };
}
