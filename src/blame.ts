import { choice, type Questions } from "@typesafe-ai/sdk";
import { ask, choiceOf, emptyUsage, errorText, mapPool, noulOf, type SystemOneCaller, type Usage } from "./client.js";
import { buildTargetQuestions, contradictKey, coverKey, type Route } from "./coverage.js";
import type { Hunk } from "./diff.js";
import type { TestFailure } from "./junit.js";
import type { Plan, Requirement } from "./requirements.js";
import { isTestFile, type TestCase } from "./tests.js";

export type Verdict = "test_wrong" | "code_wrong" | "ambiguous" | "setup_error";

export interface Blame {
    /** The failing test as the runner named it. */
    failure: string;
    testId?: string;
    requirementId?: string;
    /** p(the test is aimed at that requirement). */
    requirementP?: number;
    /** The code change judged against, when one was found. */
    hunk?: { file: string; startLine: number; endLine: number };
    verdict?: Verdict;
    /** Confidence of the verdict choice; for a contradiction found in the first request, p(contradicts). */
    confidence?: number;
    probabilities?: Record<string, number>;
    route: Route;
    reason: string;
}

export interface BlameResult {
    blames: Blame[];
    /** Failures the model could not judge. They are routed to a person, never dropped. */
    failures: { failure: string; error: string }[];
    usage: Usage;
}

export const MAX_CANDIDATE_HUNKS = 8;
export const MAX_CANDIDATE_CHARS = 24_000;

// ---------------------------------------------------------------------------------------------
// Matching a runner's failure to a test found in the source. Runners name tests differently
// ("describe > it" in Vitest, "describe it" in jest-junit, "Class::test" or "test" in pytest),
// so names are compared after collapsing separators.
// ---------------------------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\s*(>|::|›)\s*/g, " ").replace(/\s+/g, " ").trim();
const leaf = (name: string) => name.split(/\s*(?:>|::)\s*/).pop() ?? name;

function fileHint(test: TestCase, f: TestFailure): boolean {
    const path = test.file.toLowerCase();
    const dotted = path.replace(/\.[^.]+$/, "").replace(/\//g, ".");
    // The runner may report the path relative to a different root, so either may end with the other.
    const hints = [f.file ?? "", f.classname].map((h) => h.toLowerCase().replace(/\\/g, "/")).filter(Boolean);
    return hints.some((h) => h.includes(path) || h.includes(dotted) || (h.includes("/") && path.endsWith(h)));
}

export function matchTest(failure: TestFailure, tests: TestCase[]): TestCase | undefined {
    const inFile = tests.filter((t) => fileHint(t, failure));
    const pool = inFile.length > 0 ? inFile : tests;
    const name = norm(failure.name);
    const exact = pool.filter((t) => norm(t.name) === name);
    if (exact.length === 1) return exact[0];
    // jest-junit puts describe blocks in front of the title, pytest may drop the class: fall back to
    // the test's own title, and only accept it when exactly one test ends that way.
    const byLeaf = pool.filter((t) => name === norm(leaf(t.name)) || name.endsWith(` ${norm(leaf(t.name))}`) || norm(t.name).endsWith(name));
    return byLeaf.length === 1 ? byLeaf[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Picking candidate code. Code finds hunks that share identifiers with the test; the model then
// selects the one that implements the behaviour. It cannot pick a hunk that was left out.
// ---------------------------------------------------------------------------------------------

const identifiers = (s: string) => new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((w) => w.toLowerCase()));

export function candidateHunks(test: TestCase, hunks: Hunk[], max = MAX_CANDIDATE_HUNKS, maxChars = MAX_CANDIDATE_CHARS): Hunk[] {
    const words = identifiers(test.code);
    const ranked = hunks
        .filter((h) => !isTestFile(h.file))
        .map((h, i) => {
            const ids = identifiers(h.text);
            let overlap = 0;
            for (const w of ids) if (words.has(w)) overlap++;
            return { h, i, overlap };
        })
        .sort((a, b) => b.overlap - a.overlap || a.i - b.i);
    const picked: Hunk[] = [];
    let chars = 0;
    for (const { h } of ranked) {
        if (picked.length >= max || chars + h.text.length > maxChars) break;
        picked.push(h);
        chars += h.text.length;
    }
    return picked;
}

// ---------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------

const hunkLabel = (i: number) => `h${i}`;

/**
 * Request 1: which requirement the test is aimed at (and whether it contradicts one), and which
 * hunk implements what it checks. Independent, so asked together. The requirement is found with
 * the same per-requirement nouls as the coverage gate, not a Choice: a Choice matches the test
 * against each requirement's wording, so a test that expects the opposite of a requirement looks
 * like it is about none of them.
 */
export function buildLocateQuestions(requirements: Requirement[], hunks: Hunk[]): Questions {
    const questions: Questions = buildTargetQuestions(requirements);
    if (hunks.length > 0) {
        const hunkCriteria: Record<string, string> = {};
        hunks.forEach((h, i) => (hunkCriteria[hunkLabel(i)] = `\`code_hunks[${i}]\` (${h.file}, lines ${h.startLine}-${h.endLine})`));
        hunkCriteria.none = "None of the hunks in `code_hunks` implements the behaviour the test checks.";
        questions.hunk = choice(
            "Which hunk in `code_hunks` implements the behaviour that the test in `test.code` checks? Lines marked '+' were added by the change.",
            hunkCriteria
        );
    }
    return questions;
}

export const VERDICTS: Record<Verdict, string> = {
    test_wrong:
        "The test expects something `requirement` does not ask for, or expects a result that contradicts `requirement`. The code may well be right.",
    code_wrong: "The test's expectation matches `requirement`, and `code` does not do what `requirement` says (or `code` is missing).",
    ambiguous: "`requirement` can reasonably be read in two different ways, and the test and the code each follow a different reading.",
    setup_error:
        "The failure comes from setup, imports, missing dependencies, syntax errors, timeouts or the test environment, not from the behaviour in `requirement`.",
};

/** Request 2: with the requirement and code in hand, who is wrong. */
export function buildVerdictQuestions(): Questions {
    return {
        verdict: choice(
            "The test in `test.code` failed with `failure_message`. Using `requirement` as the source of truth, decide why it failed.",
            VERDICTS
        ),
    };
}

const ROUTES: Record<Verdict, Route> = {
    test_wrong: "test-agent",
    code_wrong: "code-agent",
    ambiguous: "human", // the plan needs a decision; neither agent should guess
    setup_error: "human", // environment problems are for whoever owns the harness
};

// ---------------------------------------------------------------------------------------------

async function blameOne(
    client: SystemOneCaller,
    usage: Usage,
    plan: Plan,
    failure: TestFailure,
    tests: TestCase[],
    hunks: Hunk[]
): Promise<Blame> {
    const { requirements, thresholds } = plan;
    const test = matchTest(failure, tests);
    if (!test) {
        return { failure: failure.name, route: "human", reason: "The failing test was not found (or was ambiguous) in the test files given." };
    }

    const candidates = candidateHunks(test, hunks);
    const located = await ask(
        client,
        usage,
        {
            test: { file: test.file, name: test.name, code: test.code },
            failure_message: failure.message,
            code_hunks: candidates.map((h) => ({ file: h.file, text: h.text })),
        },
        buildLocateQuestions(requirements, candidates)
    );

    let hunk: Hunk | undefined;
    if (candidates.length > 0) {
        const h = choiceOf(located, "hunk");
        if (h.choice !== "none") hunk = candidates[Number(h.choice.slice(1))];
    }
    const where = hunk && { file: hunk.file, startLine: hunk.startLine, endLine: hunk.endLine };

    const targets = requirements.map((r, i) => ({ r, covers: noulOf(located, coverKey(i)), contradicts: noulOf(located, contradictKey(i)) }));
    const conflict = targets.reduce((a, b) => (b.contradicts > a.contradicts ? b : a));
    if (conflict.contradicts >= thresholds.covered) {
        // The test expects what the plan rules out: the test is wrong whatever the code does.
        return {
            failure: failure.name,
            testId: test.id,
            requirementId: conflict.r.id,
            requirementP: conflict.covers,
            hunk: where,
            verdict: "test_wrong",
            confidence: conflict.contradicts,
            route: "test-agent",
            reason: `The test expects what requirement "${conflict.r.id}" rules out; a correct implementation would fail it.`,
        };
    }
    const best = targets.reduce((a, b) => (b.covers > a.covers ? b : a));
    const base = { failure: failure.name, testId: test.id, requirementId: best.r.id, requirementP: best.covers };
    if (best.covers < thresholds.possible) {
        return {
            failure: failure.name,
            testId: test.id,
            route: "test-agent",
            reason: "The failing test does not test any requirement in the plan: remove it, or add the requirement.",
        };
    }
    if (best.covers < thresholds.covered) {
        return { ...base, route: "human", reason: `Unclear which requirement this test is for (best is "${best.r.id}" at p=${best.covers.toFixed(2)}).` };
    }
    const requirement = best.r;

    const judged = await ask(
        client,
        usage,
        {
            requirement: requirement.text,
            test: { file: test.file, name: test.name, code: test.code },
            failure_message: failure.message,
            code: hunk ? { file: hunk.file, text: hunk.text } : "No code in the change implements this behaviour.",
        },
        buildVerdictQuestions()
    );
    const v = choiceOf(judged, "verdict");
    const verdict = v.choice as Verdict;
    const out: Blame = {
        ...base,
        hunk: where,
        verdict,
        confidence: v.confidence,
        probabilities: v.probabilities,
        route: ROUTES[verdict] ?? "human",
        reason: VERDICTS[verdict] ?? `Unknown verdict "${v.choice}".`,
    };
    if (v.confidence < thresholds.route) {
        out.route = "human";
        out.reason = `Leaning "${verdict}" but not confident (${v.confidence.toFixed(2)}): a person should decide.`;
    }
    return out;
}

export async function blameFailures(
    client: SystemOneCaller,
    plan: Plan,
    failures: TestFailure[],
    tests: TestCase[],
    hunks: Hunk[],
    options: { concurrency?: number } = {}
): Promise<BlameResult> {
    const usage = emptyUsage();
    const errors: BlameResult["failures"] = [];
    const blames = await mapPool(failures, options.concurrency ?? 4, async (f) => {
        try {
            return await blameOne(client, usage, plan, f, tests, hunks);
        } catch (err) {
            errors.push({ failure: f.name, error: errorText(err) });
            return { failure: f.name, route: "human", reason: `Not judged: ${errorText(err)}` } satisfies Blame;
        }
    });
    return { blames, failures: errors, usage };
}

/** 2 when some failures could not be judged, 1 when anything needs a person, else 0 (every failure has an agent to go to). */
export function blameExitCode(result: BlameResult): 0 | 1 | 2 {
    if (result.failures.length > 0) return 2;
    if (result.blames.some((b) => b.route === "human")) return 1;
    return 0;
}
