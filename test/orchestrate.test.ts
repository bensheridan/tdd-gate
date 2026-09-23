import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Agent, Role } from "../src/agents.js";
import type { BlameResult } from "../src/blame.js";
import type { CoverageResult } from "../src/coverage.js";
import type { DiffGateResult } from "../src/diffgates.js";
import type { TestFailure } from "../src/junit.js";
import { orchestrate, type Gates } from "../src/orchestrate.js";
import { parsePlan } from "../src/requirements.js";
import { filterDiff, splitDiff } from "../src/workspace.js";

const plan = parsePlan("requirements:\n  - {id: r1, text: f returns 1}\n");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

let repo: string;
beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tdd-gate-test-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "project\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
});

const write = (dir: string, file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
};

/** An agent that runs a script per turn and records the prompts and what it could see. */
function scripted(steps: ((cwd: string) => void)[]) {
    const prompts: string[] = [];
    const saw: string[][] = [];
    let i = 0;
    const agent: Agent = {
        run: async (prompt, cwd) => {
            prompts.push(prompt);
            saw.push(git(cwd, "ls-files").split("\n").filter((f) => f && existsSync(join(cwd, f))));
            (steps[i++] ?? (() => {}))(cwd);
        },
    };
    return { agent, prompts, saw };
}

const empty = (gate: DiffGateResult["gate"]): DiffGateResult => ({
    gate, findings: [], failures: [], truncated: [], stats: { hunks: 0, hunksJudged: 0, skipped: 0 }, usage: { requests: 0, questions: 0, inputTokens: 0, outputTokens: 0 },
});
const covered = (): CoverageResult => ({
    requirements: [{ requirementId: "r1", status: "covered", route: "none", tests: [], best: 0.9 }],
    conflicts: [], orphans: [], pairs: [], failures: [], truncatedTests: [], usage: empty("gaming").usage,
});
const gates = (over: Partial<Gates> = {}): Gates => ({
    coverage: async () => covered(),
    blame: async () => ({ blames: [], failures: [], usage: empty("gaming").usage }),
    gaming: async () => empty("gaming"),
    weakening: async () => empty("weakening"),
    drift: async () => empty("drift"),
    ...over,
});
const failing = (name: string): TestFailure => ({ name, classname: "tests/f.test.ts", message: "expected 2 to be 1" });

const TEST = 'import { f } from "../src/f";\nit("f", () => expect(f()).toBe(1));\n';

describe("workspace diff filtering", () => {
    it("splits per file, keeps owned files, drops the rest, and ignores hidden deletions and links", () => {
        const diff = [
            "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
            "diff --git a/tests/a.test.ts b/tests/a.test.ts\ndeleted file mode 100644\n--- a/tests/a.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-t\n",
            "diff --git a/tests/b.test.ts b/tests/b.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/tests/b.test.ts\n@@ -0,0 +1 @@\n+t\n",
            "diff --git a/node_modules b/node_modules\nnew file mode 120000\n--- /dev/null\n+++ b/node_modules\n@@ -0,0 +1 @@\n+/x\n",
        ].join("");
        expect(splitDiff(diff).map((b) => b.path)).toEqual(["src/a.ts", "tests/a.test.ts", "tests/b.test.ts", "node_modules"]);
        const r = filterDiff(diff, (f) => !f.includes(".test."), { hidden: ["tests/a.test.ts"], linked: ["node_modules"] });
        expect(splitDiff(r.kept).map((b) => b.path)).toEqual(["src/a.ts"]);
        expect(r.dropped).toEqual(["tests/b.test.ts"]);
    });
});

describe("orchestrate", () => {
    it("runs tests first, hides them from the code agent, drops files outside each role, and finishes on green", async () => {
        const tester = scripted([(cwd) => { write(cwd, "tests/f.test.ts", TEST); write(cwd, "src/cheat.ts", "x"); }]);
        const coder = scripted([(cwd) => { write(cwd, "src/f.ts", "export const f = () => 1;\n"); write(cwd, "tests/own.test.ts", "x"); }]);
        const r = await orchestrate({
            repo, plan, testPaths: ["tests"], gates: gates(), runTests: async () => [],
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
        });
        expect(r.status).toBe("done");
        expect(r.turns.map((t) => [t.role, t.outcome])).toEqual([["test-agent", "accepted"], ["code-agent", "accepted"]]);
        expect(coder.saw[0]).not.toContain("tests/f.test.ts");
        expect(coder.saw[0]).toContain("README.md");
        expect(r.notes.join("\n")).toContain("src/cheat.ts were discarded");
        expect(r.notes.join("\n")).toContain("tests/own.test.ts were discarded");
        expect(tester.prompts[0]).toContain("under tests");
        expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
        const files = git(repo, "ls-tree", "-r", "--name-only", r.branch).split("\n");
        expect(files).toEqual(expect.arrayContaining(["tests/f.test.ts", "src/f.ts"]));
        expect(files).not.toContain("src/cheat.ts");
        expect(files).not.toContain("tests/own.test.ts");
        expect(git(repo, "log", "--format=%s", r.branch).split("\n").slice(0, 2)).toEqual(["code-agent: turn 2", "test-agent: turn 1"]);
    });

    it("discards test files outside the test paths, and says when coverage found no tests", async () => {
        let calls = 0;
        const tester = scripted([(cwd) => write(cwd, "src/f.test.ts", TEST), (cwd) => write(cwd, "tests/f.test.ts", TEST)]);
        const coder = scripted([(cwd) => write(cwd, "src/f.ts", "export const f = () => 1;\n")]);
        const r = await orchestrate({
            repo, plan, testPaths: ["tests/"], runTests: async () => [],
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({ coverage: async (tests) => (calls++, tests.length ? covered() : { ...covered(), requirements: [{ requirementId: "r1", status: "uncovered", route: "test-agent", tests: [], best: 0 }] }) }),
        });
        expect(r.turns.map((t) => [t.role, t.outcome])).toEqual([["test-agent", "no-change"], ["test-agent", "accepted"], ["code-agent", "accepted"]]);
        expect(tester.prompts[1]).toContain("Changes to src/f.test.ts were discarded: only files named");
        expect(tester.prompts[1]).toContain("under tests are yours");
        expect(r.status).toBe("done");

    });

    it("rejects a gamed turn without applying it, and sends the finding back in the next prompt", async () => {
        const tester = scripted([(cwd) => write(cwd, "tests/f.test.ts", TEST)]);
        const coder = scripted([
            (cwd) => write(cwd, "src/f.ts", 'export const f = () => /* SPECIAL */ 1;\n'),
            (cwd) => write(cwd, "src/f.ts", "export const f = () => 1;\n"),
        ]);
        const r = await orchestrate({
            repo, plan, testPaths: ["tests"], runTests: async () => [],
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({
                gaming: async (diff) => ({
                    ...empty("gaming"),
                    findings: diff.includes("SPECIAL")
                        ? [{ gate: "gaming", ruleId: "special-case", title: "Special-cased input", severity: "error", file: "src/f.ts", startLine: 1, endLine: 1, probability: 0.9, band: "violation", route: "code-agent", message: "m" }]
                        : [],
                }),
            }),
        });
        expect(r.turns.map((t) => t.outcome)).toEqual(["accepted", "rejected", "accepted"]);
        expect(coder.prompts[1]).toContain("Special-cased input");
        expect(git(repo, "show", `${r.branch}:src/f.ts`)).not.toContain("SPECIAL");
        expect(r.status).toBe("done");
    });

    it("sends coverage gaps back to the test agent before any code is written", async () => {
        let calls = 0;
        const tester = scripted([(cwd) => write(cwd, "tests/f.test.ts", TEST), (cwd) => write(cwd, "tests/g.test.ts", TEST)]);
        const coder = scripted([(cwd) => write(cwd, "src/f.ts", "export const f = () => 1;\n")]);
        const r = await orchestrate({
            repo, plan, testPaths: ["tests"], runTests: async () => [],
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({
                coverage: async () =>
                    calls++ === 0
                        ? { ...covered(), requirements: [{ requirementId: "r1", status: "uncovered", route: "test-agent", tests: [], best: 0.1 }] }
                        : covered(),
            }),
        });
        expect(r.turns.map((t) => t.role)).toEqual(["test-agent", "test-agent", "code-agent"]);
        expect(tester.prompts[1]).toContain("Requirement [r1] has no test.");
    });

    it("stops for a person when a conflict survives a fix round, naming the requirement the test is aimed at", async () => {
        const two = parsePlan("requirements:\n  - {id: units, text: a number then a unit}\n  - {id: bare, text: a bare number is seconds}\n");
        const tester = scripted([(cwd) => write(cwd, "tests/f.test.ts", TEST), (cwd) => write(cwd, "tests/f.test.ts", TEST + "\n")]);
        const coder = scripted([]);
        const conflicted = (): CoverageResult => ({
            ...covered(),
            conflicts: [{ testId: "tests/f.test.ts::f", requirementId: "units", contradicts: 0.9 }],
            pairs: [
                { testId: "tests/f.test.ts::f", requirementId: "units", covers: 0.3, asserts: 0.9, contradicts: 0.9 },
                { testId: "tests/f.test.ts::f", requirementId: "bare", covers: 0.95, asserts: 0.9, contradicts: 0.05 },
            ],
        });
        const r = await orchestrate({
            repo, plan: two, testPaths: ["tests"], runTests: async () => [],
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({ coverage: async () => conflicted() }),
        });
        expect(r.status).toBe("needs-human");
        expect(r.turns.map((t) => t.role)).toEqual(["test-agent", "test-agent"]);
        expect(r.reasons[0]).toContain("[units] and [bare] may contradict each other");
    });

    it("routes blamed failures: the code agent gets the requirement and message, not the test", async () => {
        let runs = 0;
        const tester = scripted([(cwd) => write(cwd, "tests/f.test.ts", TEST)]);
        const coder = scripted([(cwd) => write(cwd, "src/f.ts", "export const f = () => 2;\n"), (cwd) => write(cwd, "src/f.ts", "export const f = () => 1;\n")]);
        const r = await orchestrate({
            repo, plan, testPaths: ["tests"],
            runTests: async () => (runs++ === 0 ? [failing("f")] : []),
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({
                blame: async (): Promise<BlameResult> => ({
                    blames: [{ failure: "f", testId: "tests/f.test.ts::f", requirementId: "r1", verdict: "code_wrong", confidence: 0.9, route: "code-agent", reason: "x", hunk: { file: "src/f.ts", startLine: 1, endLine: 1 } }],
                    failures: [], usage: empty("gaming").usage,
                }),
            }),
        });
        expect(r.status).toBe("done");
        expect(coder.prompts[1]).toContain('Requirement [r1] is not met (see src/f.ts:1): "f returns 1". A test failed with: expected 2 to be 1');
        expect(coder.prompts[1]).not.toContain("toBe(1)");
    });

    it("sends a test file that failed to load back to the test agent without asking blame, and names the runner", async () => {
        let runs = 0;
        let blamed = 0;
        const tester = scripted([(cwd) => write(cwd, "tests/f.test.ts", TEST), (cwd) => write(cwd, "tests/f.test.ts", TEST + "\n")]);
        const coder = scripted([(cwd) => write(cwd, "src/f.ts", "export const f = () => 1;\n")]);
        const r = await orchestrate({
            repo, plan, testPaths: ["tests"], testCommand: "npx vitest run --outputFile={junit}",
            runTests: async () => (runs++ === 0 ? [{ name: "tests/f.test.ts", classname: "tests/f.test.ts", message: "No test suite found in file" }] : []),
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({ blame: async () => { blamed++; return { blames: [], failures: [], usage: empty("gaming").usage }; } }),
        });
        expect(r.status).toBe("done");
        expect(blamed).toBe(0);
        expect(r.turns.map((t) => t.role)).toEqual(["test-agent", "code-agent", "test-agent"]);
        expect(tester.prompts[0]).toContain("`npx vitest run --outputFile=<report>`");
        expect(tester.prompts[1]).toContain("Test file tests/f.test.ts failed to run as a whole: No test suite found in file");
    });

    it("stops for a person when blame says so, and when out of turns", async () => {
        const tester = scripted([(cwd) => write(cwd, "tests/f.test.ts", TEST)]);
        const coder = scripted([(cwd) => write(cwd, "src/f.ts", "export const f = () => 2;\n")]);
        const human = await orchestrate({
            repo, plan, testPaths: ["tests"], runTests: async () => [failing("f")],
            agents: { "test-agent": tester.agent, "code-agent": coder.agent },
            gates: gates({ blame: async () => ({ blames: [{ failure: "f", route: "human", reason: "ambiguous" }], failures: [], usage: empty("gaming").usage }) }),
        });
        expect(human.status).toBe("needs-human");
        expect(human.reasons).toEqual(["f: ambiguous"]);

        const idle = scripted([]);
        const out = await orchestrate({ repo, plan, testPaths: ["tests"], maxTurns: 2, runTests: async () => [], gates: gates(), agents: { "test-agent": idle.agent, "code-agent": idle.agent } });
        expect(out.status).toBe("out-of-turns");
        expect(out.turns.map((t) => t.outcome)).toEqual(["no-change", "no-change"]);
        expect(idle.prompts[1]).toContain("You made no changes");
    });

    it("refuses a dirty repository and reports agent failures as errors", async () => {
        writeFileSync(join(repo, "dirty.txt"), "x");
        const a = scripted([]);
        await expect(orchestrate({ repo, plan, testPaths: ["tests"], runTests: async () => [], gates: gates(), agents: { "test-agent": a.agent, "code-agent": a.agent } })).rejects.toThrow("uncommitted");
        execFileSync("rm", [join(repo, "dirty.txt")]);

        const broken: Agent = { run: async () => { throw new Error("no such command"); } };
        const r = await orchestrate({ repo, plan, testPaths: ["tests"], runTests: async () => [], gates: gates(), agents: { "test-agent": broken, "code-agent": broken } });
        expect(r.status).toBe("error");
        expect(r.reasons[0]).toContain("no such command");
        expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(1);
    });
});
