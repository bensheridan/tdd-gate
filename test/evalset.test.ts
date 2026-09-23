import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Agent } from "../src/agents.js";
import { loadCases, recordingGates, saveCase, type EvalCase } from "../src/cases.js";
import type { DiffGateResult } from "../src/diffgates.js";
import { formatEvalRun, runEvalSet, scoreCase, summarise } from "../src/evalset.js";
import { harvest } from "../src/harvest.js";
import type { Gates } from "../src/orchestrate.js";
import { parsePlan } from "../src/requirements.js";

const plan = parsePlan("requirements:\n  - {id: r1, text: f returns 1}\n  - {id: r2, text: g returns 2}\n");
const usage = { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0 };
const diffResult = (gate: DiffGateResult["gate"], flagged: [string, number][] = []): DiffGateResult => ({
    gate,
    findings: flagged.map(([ruleId, p]) => ({ gate, ruleId, title: ruleId, severity: "error", file: "src/a.ts", startLine: 1, endLine: 1, probability: p, band: p >= 0.7 ? "violation" : "possible", route: "code-agent", message: "" })),
    failures: [], truncated: [], stats: { hunks: 1, hunksJudged: 1, skipped: 0 }, usage,
});
const gamingCase = (id: string, flagged: string[], source: EvalCase["labelSource"] = "construction"): EvalCase => ({
    id, kind: "special-case", plan, input: { gate: "gaming", diff: "", tests: [] }, expect: { flagged }, labelSource: source, meta: {},
});

describe("scoreCase", () => {
    it("scores every rule of a diff gate, silent rules as negatives", () => {
        const units = scoreCase(gamingCase("c", ["special-case"]), diffResult("gaming", [["special-case", 0.9], ["swallowed-error", 0.5]]));
        expect(units.map((u) => [u.metric, u.expected, u.got])).toEqual([
            ["special-case", true, true],
            ["test-aware", false, false],
            ["swallowed-error", false, false],
        ]);
        expect(units[2].probability).toBe(0.5);
    });

    it("scores coverage conflicts and blame routes", () => {
        const cov: EvalCase = { ...gamingCase("c", []), input: { gate: "coverage", tests: [] }, expect: { conflicts: ["r1"], noConflicts: ["r2"] } };
        const units = scoreCase(cov, { requirements: [], conflicts: [{ testId: "t", requirementId: "r1", contradicts: 0.9 }], orphans: [], pairs: [], failures: [], truncatedTests: [], usage });
        expect(units.map((u) => [u.subject, u.expected, u.got])).toEqual([["r1", true, true], ["r2", false, false]]);

        const bl: EvalCase = { ...gamingCase("b", []), input: { gate: "blame", failures: [{ name: "f", classname: "", message: "" }], tests: [], codeDiff: "" }, expect: { route: "code-agent", verdict: "code_wrong" } };
        const b = scoreCase(bl, { blames: [{ failure: "f", route: "test-agent", verdict: "test_wrong", reason: "" }], failures: [], usage });
        expect(b.map((u) => [u.metric, u.expected, u.got])).toEqual([["route", "code-agent", "test-agent"], ["verdict", "code_wrong", "test_wrong"]]);
    });
});

describe("summarise and runEvalSet", () => {
    it("computes precision and recall per rule and source, and never scores unlabeled cases", async () => {
        const cases = [gamingCase("a", ["special-case"]), gamingCase("b", []), gamingCase("c", ["special-case"], "review"), gamingCase("u", [], "unlabeled")];
        const said: Record<string, DiffGateResult> = {
            a: diffResult("gaming", [["special-case", 0.9]]),
            b: diffResult("gaming", [["special-case", 0.8]]),
            c: diffResult("gaming"),
            u: diffResult("gaming", [["special-case", 0.9]]),
        };
        const gates = (c: EvalCase) => ({ gaming: async () => said[c.id] }) as unknown as Gates;
        const run = await runEvalSet(cases, gates);
        expect(run.scored).toBe(3);
        expect(run.unlabeled.map((c) => c.id)).toEqual(["u"]);
        const all = run.metrics.find((m) => m.metric === "special-case" && m.source === "all")!;
        expect([all.tp, all.fp, all.fn, all.tn, all.precision, all.recall]).toEqual([1, 1, 1, 0, 0.5, 0.5]);
        const cons = run.metrics.find((m) => m.metric === "special-case" && m.source === "construction")!;
        expect([cons.tp, cons.fp]).toEqual([1, 1]);
        const text = formatEvalRun(run);
        expect(text).toContain("b  [gaming special-case] false alarm (p=0.80)");
        expect(text).toContain("c  [gaming special-case] missed");
    });

    it("summarises categorical metrics with a confusion table", () => {
        const m = summarise([
            { caseId: "x", source: "construction", gate: "blame", metric: "route", subject: "f", expected: "code-agent", got: "code-agent" },
            { caseId: "y", source: "construction", gate: "blame", metric: "route", subject: "g", expected: "code-agent", got: "human" },
        ]).find((x) => x.source === "all")!;
        expect([m.correct, m.total]).toEqual([1, 2]);
        expect(m.confusion).toEqual({ "code-agent": { "code-agent": 1, human: 1 } });
    });
});

describe("recordingGates and case files", () => {
    it("saves each gate call as an unlabeled case that loads back", async () => {
        const dir = mkdtempSync(join(tmpdir(), "tdd-gate-cases-"));
        const inner = { gaming: async () => diffResult("gaming"), drift: async () => diffResult("drift") } as unknown as Gates;
        const g = recordingGates(inner, plan, (c) => saveCase(dir, c), "run-x", { plan: "p" });
        await g.gaming("DIFF", []);
        await g.drift("DIFF2");
        const cases = loadCases(dir);
        expect(cases.map((c) => [c.id, c.input.gate, c.labelSource])).toEqual([["run-x/001-gaming", "gaming", "unlabeled"], ["run-x/002-drift", "drift", "unlabeled"]]);
        expect(cases[1].input).toEqual({ gate: "drift", diff: "DIFF2" });
        expect(cases[0].recorded).toBeTruthy();
    });
});

describe("harvest", () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const write = (dir: string, file: string, text: string) => {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
    };
    beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), "tdd-gate-harvest-"));
        git("init", "-q", "-b", "main");
        git("config", "user.email", "t@t");
        git("config", "user.name", "t");
        write(repo, "README.md", "plan\n");
        git("add", "-A");
        git("commit", "-q", "-m", "plan");
        git("switch", "-q", "-c", "run");
        write(repo, "src/f.ts", "export const f = () => 1;\n");
        write(repo, "tests/f.test.ts", 'it("f", () => expect(f()).toBe(1));\n');
        git("add", "-A");
        git("commit", "-q", "-m", "run");
    });

    it("labels mutants by construction, checks them against the tests, and discards survivors", async () => {
        // The agent does what code-bug asks only for r1; for r2 it changes something harmless.
        const agent: Agent = {
            run: async (prompt, cwd) => {
                if (prompt.includes("f returns 1")) write(cwd, "src/f.ts", "export const f = () => 2;\n");
                else write(cwd, "src/f.ts", "export const f = () => 1; // same\n");
            },
        };
        const runTests = async (dir: string) => {
            const src = execFileSync("cat", [join(dir, "src/f.ts")], { encoding: "utf8" });
            return src.includes("=> 2") ? [{ name: "f", classname: "tests/f.test.ts", message: "expected 2 to be 1" }] : [];
        };
        const quiet = {
            blame: async () => ({ blames: [], failures: [], usage }),
            gaming: async () => diffResult("gaming"),
            drift: async () => diffResult("drift"),
        } as unknown as Gates;
        const r = await harvest({ repo, head: "run", base: "main", plan, name: "p", testPaths: ["tests"], agent, gates: quiet, runTests, kinds: ["code-bug"], link: [] });
        expect(r.cases.map((c) => [c.id, c.labelSource, c.expect])).toEqual([
            ["p/code-bug-r1-blame", "construction", { route: "code-agent", verdict: "code_wrong" }],
            ["p/code-bug-r1-drift", "construction", { flagged: [] }],
            ["p/code-bug-r1-gaming", "construction", { flagged: [] }],
        ]);
        const blame = r.cases[0].input;
        expect(blame.gate === "blame" && blame.failures.map((f) => f.name)).toEqual(["f"]);
        expect(blame.gate === "blame" && blame.codeDiff).toContain("+export const f = () => 2;");
        expect(r.discarded).toEqual([{ id: "p/code-bug-r2", reason: "no test failed (the mutant survived)" }]);
        expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
    });
});
