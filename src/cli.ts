#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blameExitCode, blameFailures, candidateHunks, matchTest } from "./blame.js";
import { createClient } from "./client.js";
import { checkCoverage, coverageExitCode } from "./coverage.js";
import { applicableDiffRules, checkDiff, diffExitCode, gateHunks, type Gate } from "./diffgates.js";
import { checkDrift } from "./drift.js";
import { codeAgentPrompt, commandAgent, DEFAULT_AGENT_COMMAND, testAgentPrompt } from "./agents.js";
import { commandTestRunner, orchestrate, typesafeGates } from "./orchestrate.js";
import { parseDiff } from "./diff.js";
import { loadJunit } from "./junit.js";
import { formatBlame, formatCoverage, formatDiffGate, formatJson } from "./report.js";
import { DEFAULT_THRESHOLDS, loadPlan, PlanError } from "./requirements.js";
import { loadTests } from "./tests.js";

const USAGE = `tdd-gate: keeps a test agent and a code agent on the same plan (TypeSafe / Jev)

Usage:
  tdd-gate coverage --requirements <yml> --tests <path> [--tests <path>...]
      Which tests cover which requirements, which are weak, which contradict the plan, which match nothing.

  tdd-gate blame --requirements <yml> --tests <path>... --junit <xml|-> <diff>
      For each failing test: is the test wrong, the code wrong, or the requirement ambiguous?

  tdd-gate gaming <diff> [--tests <path>...] [--requirements <yml>]
      Does the code agent's change (non-test files) pass tests without meeting the plan?
      Special-cased inputs, test-aware code, swallowed errors. --tests adds the tests' literal
      values as evidence.

  tdd-gate weakening <diff> [--requirements <yml>]
      Did the test agent's change (test files) make the tests easier to pass? Loosened, skipped
      or removed assertions, deleted test files.

  tdd-gate drift --requirements <yml> <diff>
      Does the code agent's change (non-test files) add behaviour no requirement asks for?
      Also prints which requirements each changed hunk serves.

  tdd-gate run --requirements <yml> --test-command "<cmd writing JUnit to {junit}>"
               [--repo <dir>] [--tests <path in repo>...] [--agent <cmd>]
               [--test-agent <cmd>] [--code-agent <cmd>] [--max-turns <n>] [--link <path>...]
      Reference orchestrator: runs a test agent and a code agent against the plan through all
      the gates, committing accepted turns to a new tdd-gate/run-* branch in the repo. Agents
      get the prompt on stdin in a throwaway worktree; the code agent's has no test files.
      Default agent: ${DEFAULT_AGENT_COMMAND}

  <diff> is --diff <file|-> or --base <ref> [--head <ref>] (git diff base...head).
  --code-diff is accepted as another name for --diff. --requirements supplies thresholds.

Options:
  --format text|json      Output format (default text). json is for the orchestrator.
  --concurrency <n>       Parallel requests (default 4)
  --dry-run               Show what would be asked; no API call, no key needed
  -h, --help

Environment: TYPESAFE_API_KEY

Exit codes:
  coverage  0 all requirements covered, 1 a test conflicts or a requirement is uncovered / weak, 2 not judged / bad input
  blame     0 every failure routed to an agent, 1 some need a person, 2 not judged / bad input
  gaming    0 nothing flagged, 1 a rule violated, 2 not judged / bad input
  weakening 0 nothing flagged, 1 a loosened or skipped test, 2 not judged / bad input
            (removed assertions and deleted test files are reported for a person, never fail)
  drift     0 nothing flagged, 1 unrequested behaviour, 2 not judged / bad input
            (hunks no requirement needs are reported for a person, never fail)
  run       0 all tests pass, 1 stopped for a person or out of turns, 2 error / bad input`;

interface Args {
    command: "coverage" | "blame" | "drift" | "run" | Gate;
    flags: Map<string, string[]>;
    bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
    const [command, ...rest] = argv;
    if (!["coverage", "blame", "gaming", "weakening", "drift", "run"].includes(command)) {
        throw new Error(`Unknown command "${command ?? ""}". Use coverage, blame, gaming, weakening, drift or run (see --help).`);
    }
    const flags = new Map<string, string[]>();
    const bools = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith("-")) throw new Error(`Unexpected argument "${a}".`);
        const name = a.replace(/^-+/, "");
        if (name === "dry-run") {
            bools.add(name);
            continue;
        }
        const value = rest[++i];
        if (value === undefined) throw new Error(`Option ${a} needs a value.`);
        flags.set(name, [...(flags.get(name) ?? []), value]);
    }
    return { command: command as Args["command"], flags, bools };
}

const str = (args: Args, name: string) => args.flags.get(name)?.at(-1);
const need = (args: Args, name: string) => {
    const v = str(args, name);
    if (!v) throw new Error(`--${name} is required.`);
    return v;
};

// A ref that starts with "-" would be read by git as an option.
const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9_./^~@{}:-]*$/;

function readDiff(args: Args): string {
    const file = str(args, "diff") ?? str(args, "code-diff");
    if (file) return readFileSync(file === "-" ? 0 : file, "utf8");
    const base = str(args, "base");
    if (!base) throw new Error(`${args.command} needs a change: --diff <file|-> or --base <ref>.`);
    const head = str(args, "head") ?? "HEAD";
    for (const ref of [base, head]) if (!SAFE_REF.test(ref)) throw new Error(`"${ref}" is not a valid git ref.`);
    return execFileSync("git", ["-c", "core.quotepath=false", "diff", "-U10", "--no-color", "--no-ext-diff", `${base}...${head}`], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
        console.log(USAGE);
        return argv.length === 0 ? 2 : 0;
    }
    const args = parseArgs(argv);

    // Validate everything cheap before any API call.
    const format = str(args, "format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error(`Unknown --format "${format}". Use text or json.`);
    const concurrency = Number(str(args, "concurrency") ?? 4);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer.");
    const dryRun = args.bools.has("dry-run");
    const testPaths = args.flags.get("tests") ?? [];

    if (args.command === "gaming" || args.command === "weakening") {
        const gate = args.command;
        const thresholds = str(args, "requirements") ? loadPlan(str(args, "requirements")!).thresholds : DEFAULT_THRESHOLDS;
        const tests = gate === "gaming" && testPaths.length > 0 ? loadTests(testPaths) : undefined;
        const diff = readDiff(args);
        if (dryRun) {
            let questions = 0;
            let requests = 0;
            for (const h of gateHunks(gate, diff)) {
                const rules = applicableDiffRules(gate, h);
                if (rules.length === 0) continue;
                requests++;
                questions += rules.length;
                console.log(`${h.file}:${h.startLine}-${h.endLine}  -> ${rules.map((r) => r.id).join(", ")}`);
            }
            console.log(`\nWould send ${requests} request(s) with ${questions} question(s). Nothing was sent.`);
            return 0;
        }
        const result = await checkDiff(createClient(), gate, diff, thresholds, { concurrency, tests });
        console.log(format === "json" ? formatJson(result) : formatDiffGate(result));
        return diffExitCode(result);
    }

    const plan = loadPlan(need(args, "requirements"));

    if (args.command === "run") {
        const repo = resolve(str(args, "repo") ?? ".");
        const testCommand = need(args, "test-command");
        if (!testCommand.includes("{junit}")) throw new Error("--test-command must write a JUnit report to {junit}, e.g. \"npx vitest run --reporter=junit --outputFile={junit}\".");
        const agentCmd = str(args, "agent") ?? DEFAULT_AGENT_COMMAND;
        const testAgentCmd = str(args, "test-agent") ?? agentCmd;
        const codeAgentCmd = str(args, "code-agent") ?? agentCmd;
        const maxTurns = Number(str(args, "max-turns") ?? 12);
        if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("--max-turns must be a positive integer.");
        const tests = testPaths.length ? testPaths : ["."];
        const link = args.flags.get("link") ?? ["node_modules"];
        if (dryRun) {
            console.log(`repo:          ${repo}\ntests:         ${tests.join(", ")}\ntest command:  ${testCommand}\ntest agent:    ${testAgentCmd}\ncode agent:    ${codeAgentCmd}\nmax turns:     ${maxTurns}\nlinked:        ${link.join(", ")}`);
            console.log(`\n--- first test-agent prompt ---\n${testAgentPrompt(plan.requirements, [], "files named *.test.* / *.spec.*, test_*.py or *_test.py", testCommand)}`);
            console.log(`--- first code-agent prompt ---\n${codeAgentPrompt(plan.requirements, [])}`);
            console.log("Nothing was run.");
            return 0;
        }
        const log = (line: string) => console.error(`[tdd-gate] ${line}`);
        const result = await orchestrate({
            repo,
            plan,
            testPaths: tests,
            agents: { "test-agent": commandAgent(testAgentCmd), "code-agent": commandAgent(codeAgentCmd) },
            gates: typesafeGates(createClient(), plan, concurrency),
            runTests: commandTestRunner(testCommand),
            testCommand,
            maxTurns,
            link,
            log,
        });
        if (format === "json") console.log(formatJson(result));
        else {
            for (const t of result.turns) {
                console.log(`turn ${t.n}  ${t.role.padEnd(10)} ${t.outcome}${t.commit ? ` ${t.commit.slice(0, 7)}` : ""}`);
                for (const f of t.feedback) for (const i of f.items) console.log(`          -> ${f.role}: ${i}`);
            }
            for (const n of result.notes) console.log(`NOTE ${n}`);
            for (const r of result.reasons) console.log(`${result.status === "error" ? "ERROR" : "NEEDS YOU"} ${r}`);
            console.log(`\n${result.status}: ${result.turns.length} turn(s). Commits are on branch ${result.branch}.`);
        }
        return result.status === "done" ? 0 : result.status === "error" ? 2 : 1;
    }

    if (args.command === "drift") {
        const diff = readDiff(args);
        if (dryRun) {
            const hunks = gateHunks("drift", diff).filter((h) => h.addedLines.length > 0);
            for (const h of hunks) console.log(`${h.file}:${h.startLine}-${h.endLine}`);
            const n = plan.requirements.length;
            console.log(`\nWould send ${hunks.length} request(s), one per hunk, each with ${n + 2} question(s) (needed by each of ${n} requirement(s), extra, housekeeping). Nothing was sent.`);
            return 0;
        }
        const result = await checkDrift(createClient(), diff, plan, { concurrency });
        console.log(format === "json" ? formatJson(result) : formatDiffGate(result));
        return diffExitCode(result);
    }

    if (testPaths.length === 0) throw new Error("--tests is required (a test file or a directory to search).");
    const tests = loadTests(testPaths);
    if (tests.length === 0) throw new Error(`No tests found under ${testPaths.join(", ")}.`);

    if (args.command === "coverage") {
        if (dryRun) {
            for (const t of tests) console.log(`${t.id}${t.truncated ? " (truncated)" : ""}`);
            const n = plan.requirements.length;
            console.log(`\nWould send ${tests.length} request(s), one per test, each with ${3 * n} question(s) (covers, asserts, contradicts for ${n} requirement(s)). Nothing was sent.`);
            return 0;
        }
        const result = await checkCoverage(createClient(), tests, plan, { concurrency });
        console.log(format === "json" ? formatJson(result) : formatCoverage(result));
        return coverageExitCode(result);
    }

    const failures = loadJunit(need(args, "junit"));
    const hunks = parseDiff(readDiff(args));
    if (dryRun) {
        for (const f of failures) {
            const test = matchTest(f, tests);
            if (!test) {
                console.log(`${f.name}  -> not found in the test files; would route to human without asking`);
                continue;
            }
            const c = candidateHunks(test, hunks);
            console.log(`${f.name}  -> ${test.id}; ${c.length} candidate hunk(s): ${c.map((h) => `${h.file}:${h.startLine}`).join(", ") || "none"}`);
        }
        console.log(`\nWould send up to ${failures.length * 2} request(s): locate (requirement + hunk), then verdict, per failure. Nothing was sent.`);
        return 0;
    }
    if (failures.length === 0) {
        console.log(format === "json" ? formatJson({ blames: [], failures: [] }) : "No failing tests in the report.");
        return 0;
    }
    const result = await blameFailures(createClient(), plan, failures, tests, hunks, { concurrency });
    console.log(format === "json" ? formatJson(result) : formatBlame(result));
    return blameExitCode(result);
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(err instanceof PlanError ? `Requirements error: ${err.message}` : `Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
    }
);
