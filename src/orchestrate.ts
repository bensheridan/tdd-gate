import { exec } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeAgentPrompt, testAgentPrompt, type Agent, type Role } from "./agents.js";
import { blameFailures, matchTest, type BlameResult } from "./blame.js";
import type { SystemOneCaller } from "./client.js";
import { checkCoverage, coverageExitCode, type CoverageResult } from "./coverage.js";
import { parseDiff } from "./diff.js";
import { checkDiff, type DiffGateResult } from "./diffgates.js";
import { checkDrift } from "./drift.js";
import { parseJunit, type TestFailure } from "./junit.js";
import type { Plan } from "./requirements.js";
import { isTestFile, loadTests, type TestCase } from "./tests.js";
import * as ws from "./workspace.js";

/**
 * Reference orchestrator: two agents, one plan, five gates.
 *
 *   test agent turn ─> weakening (once code exists) ─> commit ─> coverage ─┬─> test agent (gaps)
 *                                                                          └─> code agent
 *   code agent turn ─> gaming + drift ─> commit ─> run tests ─┬─> done (all pass)
 *                                                             └─> blame ─> test agent / code agent / stop for a person
 *
 * A turn a gate rejects is never applied; its findings go back to the same agent. The code agent
 * works in a worktree with every test file deleted, so it cannot read the tests.
 */

export interface Gates {
    coverage(tests: TestCase[]): Promise<CoverageResult>;
    blame(failures: TestFailure[], tests: TestCase[], codeDiff: string): Promise<BlameResult>;
    gaming(diff: string, tests: TestCase[]): Promise<DiffGateResult>;
    weakening(diff: string): Promise<DiffGateResult>;
    drift(diff: string): Promise<DiffGateResult>;
}

export function typesafeGates(client: SystemOneCaller, plan: Plan, concurrency = 4): Gates {
    const t = plan.thresholds;
    return {
        coverage: (tests) => checkCoverage(client, tests, plan, { concurrency }),
        blame: (failures, tests, codeDiff) => blameFailures(client, plan, failures, tests, parseDiff(codeDiff), { concurrency }),
        gaming: (diff, tests) => checkDiff(client, "gaming", diff, t, { concurrency, tests }),
        weakening: (diff) => checkDiff(client, "weakening", diff, t, { concurrency }),
        drift: (diff) => checkDrift(client, diff, plan, { concurrency }),
    };
}

/** Runs the project's tests and returns the failures. Throws when no report was produced. */
export type TestRunner = (repo: string) => Promise<TestFailure[]>;

/**
 * `command` runs in the project through a shell, like an npm script: it is the user's own command.
 * `{junit}` in it is replaced by the (quoted) path the report must be written to.
 */
export function commandTestRunner(command: string, timeoutMs = 10 * 60_000): TestRunner {
    return (repo) =>
        new Promise((resolve, reject) => {
            const dir = mkdtempSync(join(tmpdir(), "tdd-gate-junit-"));
            const junit = join(dir, "results.xml");
            const quoted = `'${junit.replace(/'/g, `'\\''`)}'`;
            exec(command.replaceAll("{junit}", quoted), { cwd: repo, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => {
                // A failing test run exits non-zero; only a missing report is an error.
                try {
                    if (!existsSync(junit)) {
                        const tail = `${stdout}\n${stderr}`.trim().slice(-800);
                        reject(new Error(`The test command wrote no JUnit report (does it write to {junit}?).\n${tail}`));
                        return;
                    }
                    resolve(parseJunit(readFileSync(junit, "utf8")));
                } finally {
                    rmSync(dir, { recursive: true, force: true });
                }
            });
        });
}

export interface RunOptions {
    repo: string;
    plan: Plan;
    /** Where tests live, relative to the repo (files or directories). */
    testPaths: string[];
    agents: Record<Role, Agent>;
    gates: Gates;
    runTests: TestRunner;
    /** Shown to the test agent so it writes tests for the right runner. */
    testCommand?: string;
    maxTurns?: number;
    /** Paths symlinked from the project into each agent's worktree (default node_modules). */
    link?: string[];
    branch?: string;
    log?: (line: string) => void;
}

export interface Turn {
    n: number;
    role: Role;
    outcome: "accepted" | "rejected" | "no-change" | "agent-failed";
    commit?: string;
    /** What was sent back to an agent after this turn. */
    feedback: { role: Role; items: string[] }[];
    notes: string[];
}

export interface RunResult {
    status: "done" | "needs-human" | "out-of-turns" | "error";
    branch: string;
    turns: Turn[];
    /** Why a person is needed, when status is needs-human or error. */
    reasons: string[];
    /** Reported but not blocking: possible findings, warnings, dropped files. */
    notes: string[];
}

const loc = (f: { file: string; startLine: number; endLine: number }) => (f.endLine > f.startLine ? `${f.file}:${f.startLine}-${f.endLine}` : `${f.file}:${f.startLine}`);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";

/** Findings a gate says the agent must fix (the turn is rejected), and the rest as notes. */
function splitFindings(result: DiffGateResult, role: Role): { reject: string[]; notes: string[] } {
    const reject: string[] = [];
    const notes: string[] = [];
    for (const f of result.findings) {
        const text = `${loc(f)}: ${f.title}. ${f.message}`;
        if (f.route === role) reject.push(text);
        else notes.push(`${result.gate}: ${text}`);
    }
    for (const f of result.failures) notes.push(`${result.gate}: ${f.file}:${f.startLine} not judged (${f.error})`);
    return { reject, notes };
}

function coverageFeedback(result: CoverageResult): { items: string[]; notes: string[] } {
    const items: string[] = [];
    const notes: string[] = [];
    for (const r of result.requirements) {
        if (r.status === "uncovered") items.push(`Requirement [${r.requirementId}] has no test.`);
        else if (r.status === "weak")
            items.push(`Requirement [${r.requirementId}]: ${r.tests.map((t) => `"${t.testId}"`).join(", ")} would still pass if the requirement were not met. Assert the exact result.`);
        else if (r.status === "possible") notes.push(`coverage: requirement [${r.requirementId}] is only possibly covered (best p=${r.best.toFixed(2)}).`);
    }
    for (const c of result.conflicts) items.push(`Test "${c.testId}" expects what requirement [${c.requirementId}] rules out. Change the test to match the requirement.`);
    for (const o of result.orphans) items.push(`Test "${o.testId}" does not test any requirement. Remove it.`);
    return { items, notes };
}

export async function orchestrate(options: RunOptions): Promise<RunResult> {
    const { repo, plan, agents, gates, runTests } = options;
    const maxTurns = options.maxTurns ?? 12;
    const link = options.link ?? ["node_modules"];
    const log = options.log ?? (() => {});
    const load = () => loadTests(options.testPaths, repo);
    // Coverage only looks where it is told, so the test agent must be told the same place.
    const where = options.testPaths.filter((p) => p !== "." && p !== "./");
    const testHint = `files named *.test.* / *.spec.*, test_*.py or *_test.py${where.length ? `, under ${where.join(" or ")}` : ""}`;

    ws.assertClean(repo);
    const original = ws.currentBranch(repo);
    const branch = options.branch ?? `tdd-gate/run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    ws.createBranch(repo, branch);
    const base = ws.head(repo);
    log(`run branch ${branch} from ${base.slice(0, 7)}`);

    const turns: Turn[] = [];
    const notes: string[] = [];
    const pending: Record<Role, string[]> = { "test-agent": [], "code-agent": [] };
    let next: Role = "test-agent";
    let codeExists = false;
    const finish = (status: RunResult["status"], reasons: string[] = []): RunResult => ({ status, branch, turns, reasons, notes });

    try {
        for (let n = 1; n <= maxTurns; n++) {
            const role: Role = next;
            const turn: Turn = { n, role, outcome: "accepted", feedback: [], notes: [] };
            turns.push(turn);
            const send = (to: Role, items: string[]) => {
                if (items.length === 0) return;
                pending[to].push(...items);
                turn.feedback.push({ role: to, items });
            };
            const note = (items: string[]) => {
                turn.notes.push(...items);
                notes.push(...items.map((i) => `turn ${n}: ${i}`));
            };

            // 1. The agent works in a fresh worktree. The code agent's has no test files in it.
            const feedback = pending[role].splice(0);
            const prompt = role === "test-agent" ? testAgentPrompt(plan.requirements, feedback, testHint, options.testCommand) : codeAgentPrompt(plan.requirements, feedback);
            const wt = ws.openWorktree(repo, role === "code-agent" ? isTestFile : () => false, link);
            log(`turn ${n}: ${role}${feedback.length ? ` with ${feedback.length} feedback item(s)` : ""}`);
            let diff: string;
            try {
                await agents[role].run(prompt, wt.dir);
                diff = ws.worktreeDiff(wt);
            } catch (err) {
                turn.outcome = "agent-failed";
                return finish("error", [`${role} failed on turn ${n}: ${err instanceof Error ? err.message : String(err)}`]);
            } finally {
                wt.remove();
            }

            // 2. Keep only the files this agent owns.
            const owns = role === "test-agent" ? isTestFile : (f: string) => !isTestFile(f);
            const { kept, dropped } = ws.filterDiff(diff, owns, wt);
            if (dropped.length) {
                const msg = `Changes to ${dropped.join(", ")} were discarded: ${role === "test-agent" ? "only test files are yours" : "test files are not yours"}.`;
                send(role, [msg]);
                note([msg]);
            }
            if (!kept) {
                turn.outcome = "no-change";
                send(role, ["You made no changes to files you are allowed to change."]);
                next = role;
                continue;
            }

            // 3. Gate the turn before it touches the project.
            const reject: string[] = [];
            if (role === "code-agent") {
                for (const result of [await gates.gaming(kept, load()), await gates.drift(kept)]) {
                    const s = splitFindings(result, role);
                    reject.push(...s.reject);
                    note(s.notes);
                }
            } else if (codeExists) {
                const s = splitFindings(await gates.weakening(kept), role);
                reject.push(...s.reject);
                note(s.notes);
            }
            if (reject.length) {
                turn.outcome = "rejected";
                send(role, reject.map((r) => `${r} This change was rejected; redo it without this.`));
                log(`turn ${n}: rejected (${reject.length} finding(s))`);
                next = role;
                continue;
            }

            turn.commit = ws.applyAndCommit(repo, kept, `${role}: turn ${n}`);
            log(`turn ${n}: accepted as ${turn.commit.slice(0, 7)}`);

            // 4. After tests change: are they the right tests?
            if (role === "test-agent") {
                const coverage = await gates.coverage(load());
                const code = coverageExitCode(coverage);
                if (code === 2) return finish("error", coverage.failures.map((f) => `coverage could not judge ${f.testId}: ${f.error}`));
                const cf = coverageFeedback(coverage);
                note(cf.notes);
                if (code === 1) {
                    send("test-agent", cf.items);
                    next = "test-agent";
                    continue;
                }
                if (!codeExists) {
                    next = "code-agent";
                    continue;
                }
            } else {
                codeExists = true;
            }

            // 5. Code exists and the tests are right: run them.
            const failures = await runTests(repo);
            log(`turn ${n}: ${failures.length} failing test(s)`);
            if (failures.length === 0) return finish("done");

            // A test file that fails to load is reported under the file's name, not a test's: it goes
            // back to the test agent with the runner's message. Blame judges individual tests only.
            const tests = load();
            const fileLevel = failures.filter((f) => !matchTest(f, tests) && (f.name === f.classname || isTestFile(f.name)));
            send("test-agent", fileLevel.map((f) => `Test file ${f.name} failed to run as a whole: ${firstLine(f.message)}`));
            const perTest = failures.filter((f) => !fileLevel.includes(f));
            if (perTest.length === 0) {
                next = "test-agent";
                continue;
            }
            const blame = await gates.blame(perTest, tests, ws.diffBetween(repo, base));
            const human = blame.blames.filter((b) => b.route === "human");
            if (human.length) return finish("needs-human", human.map((b) => `${b.failure}: ${b.reason}`));
            const toTests = blame.blames.filter((b) => b.route === "test-agent");
            const toCode = blame.blames.filter((b) => b.route === "code-agent");
            send("test-agent", toTests.map((b) => `Test "${b.testId ?? b.failure}" is wrong: ${b.reason}`));
            // The code agent gets the requirement and the assertion message, never the test source.
            send(
                "code-agent",
                toCode.map((b) => {
                    const req = plan.requirements.find((r) => r.id === b.requirementId);
                    const f = failures.find((x) => x.name === b.failure);
                    return `Requirement [${b.requirementId}] is not met${b.hunk ? ` (see ${loc(b.hunk)})` : ""}: "${req?.text ?? ""}". A test failed with: ${firstLine(f?.message ?? "")}`;
                })
            );
            // Fix wrong tests first: until they are right, a failure says nothing about the code.
            next = toTests.length || fileLevel.length ? "test-agent" : "code-agent";
        }
        return finish("out-of-turns", [`Stopped after ${maxTurns} turns.`]);
    } catch (err) {
        return finish("error", [err instanceof Error ? err.message : String(err)]);
    } finally {
        ws.switchTo(repo, original);
        log(`back on ${original}; the run's commits are on ${branch}`);
    }
}
