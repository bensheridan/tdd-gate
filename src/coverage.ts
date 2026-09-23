import { noul, type Questions } from "@typesafe-ai/sdk";
import { ask, emptyUsage, errorText, mapPool, noulOf, type SystemOneCaller, type Usage } from "./client.js";
import type { Plan, Requirement } from "./requirements.js";
import type { TestCase } from "./tests.js";

export interface Pair {
    testId: string;
    requirementId: string;
    /** p(the test is aimed at this requirement's behaviour), regardless of how well it checks it. */
    covers: number;
    /** p(its assertions would fail if the code did not meet the requirement), asked on the premise that it targets it. */
    asserts: number;
    /** p(the test expects a result that the requirement rules out). */
    contradicts: number;
}

/**
 * covered:   some test covers it and would catch a broken implementation
 * weak:      covered, but no covering test's assertions would catch a broken implementation
 * possible:  the best test is between the thresholds; a person should look
 * uncovered: no test is about it
 */
export type Status = "covered" | "weak" | "possible" | "uncovered";

/** Who acts next. The orchestrator reads this; the gate never contacts an agent itself. */
export type Route = "test-agent" | "code-agent" | "human" | "none";

export interface RequirementCoverage {
    requirementId: string;
    status: Status;
    route: Route;
    /** Tests at or above the covered threshold, most likely first. */
    tests: { testId: string; covers: number; asserts: number }[];
    /** Highest p(covers) over all tests, so "uncovered" can be told apart from "nearly covered". */
    best: number;
}

export interface CoverageResult {
    requirements: RequirementCoverage[];
    /** Tests that expect what a requirement rules out. Caught before any code exists; always go back to the test agent. */
    conflicts: { testId: string; requirementId: string; contradicts: number }[];
    /** Tests that match no requirement: scope creep, or a requirement missing from the plan. */
    orphans: { testId: string; best: number }[];
    pairs: Pair[];
    /** Tests the model could not judge. Never counted as clean. */
    failures: { testId: string; error: string }[];
    truncatedTests: string[];
    usage: Usage;
}

// Three separate judgments per (test, requirement), because the model reads each one literally:
// what the test is aimed at, whether its assertions have teeth, and whether it expects the opposite.
const COVER_TASK =
    "Decide whether the test in `test.code` is aimed at the behaviour described in `requirement`: " +
    "its name, setup or input is about that behaviour. " +
    "Whether its assertions are strong enough, or agree with the requirement, is judged separately and does NOT matter here. " +
    "A test that only calls the same function but is about a different behaviour does NOT count.";

const ASSERT_TASK =
    "Assume the test in `test.code` is meant to test `requirement`. " +
    "Decide whether its assertions would fail if the code under test did NOT do what `requirement` says. " +
    "Assertions that only check that the code runs, does not throw, returns something, or returns the right type do NOT count, " +
    "unless that is all the requirement asks for.";

const CONTRADICT_TASK =
    "Decide whether the test in `test.code` expects a result that `requirement` rules out, " +
    "so that code meeting the requirement would make the test fail. " +
    "A test about a different behaviour, or one that checks less than the requirement asks for, does NOT count.";

export const coverKey = (i: number) => `cover_${i}`;
const assertKey = (i: number) => `assert_${i}`;
export const contradictKey = (i: number) => `contradict_${i}`;

/** Whether a test is aimed at a requirement, and whether it expects the opposite. Shared with blame so both gates judge alike. */
export function buildTargetQuestions(requirements: Requirement[]): Questions {
    const questions: Questions = {};
    requirements.forEach((r, i) => {
        questions[coverKey(i)] = noul(
            { task: COVER_TASK, requirement: r.text },
            { true: "The test is aimed at this behaviour.", false: "The test is about something else, or only touches the same code." }
        );
        questions[contradictKey(i)] = noul(
            { task: CONTRADICT_TASK, requirement: r.text },
            {
                true: "The test expects something the requirement forbids; a correct implementation would fail it.",
                false: "The test agrees with the requirement, checks less than it, or is about something else.",
            }
        );
    });
    return questions;
}

/** Three nouls per requirement, all about one test, sent together. The assert question is speculative. */
export function buildCoverageQuestions(requirements: Requirement[]): Questions {
    const questions: Questions = buildTargetQuestions(requirements);
    requirements.forEach((r, i) => {
        questions[assertKey(i)] = noul(
            { task: ASSERT_TASK, requirement: r.text },
            {
                true: "A wrong implementation of the requirement would make the test fail.",
                false: "The test could still pass if the requirement were not met.",
            }
        );
    });
    return questions;
}

export const testState = (t: TestCase) => ({ test: { file: t.file, name: t.name, code: t.code } });

export async function checkCoverage(
    client: SystemOneCaller,
    tests: TestCase[],
    plan: Plan,
    options: { concurrency?: number } = {}
): Promise<CoverageResult> {
    const { requirements, thresholds } = plan;
    const usage = emptyUsage();
    const questions = buildCoverageQuestions(requirements);

    const outcomes = await mapPool(tests, options.concurrency ?? 4, async (test) => {
        try {
            const answers = await ask(client, usage, testState(test), questions);
            const pairs = requirements.map((r, i) => ({
                testId: test.id,
                requirementId: r.id,
                covers: noulOf(answers, coverKey(i)),
                asserts: noulOf(answers, assertKey(i)),
                contradicts: noulOf(answers, contradictKey(i)),
            }));
            return { test, pairs, error: null as string | null };
        } catch (err) {
            return { test, pairs: [] as Pair[], error: errorText(err) };
        }
    });

    const pairs = outcomes.flatMap((o) => o.pairs);
    const failures = outcomes.filter((o) => o.error).map((o) => ({ testId: o.test.id, error: o.error! }));

    const coverage = requirements.map((r): RequirementCoverage => {
        // A test that expects the opposite is not coverage, however squarely it is aimed.
        const mine = pairs.filter((p) => p.requirementId === r.id && p.contradicts < thresholds.covered);
        const best = Math.max(0, ...mine.map((p) => p.covers));
        const covering = mine
            .filter((p) => p.covers >= thresholds.covered)
            .sort((a, b) => b.covers - a.covers)
            .map(({ testId, covers, asserts }) => ({ testId, covers, asserts }));
        let status: Status;
        if (covering.some((p) => p.asserts >= thresholds.strong)) status = "covered";
        else if (covering.length > 0) status = "weak";
        else if (best >= thresholds.possible) status = "possible";
        else status = "uncovered";
        const route: Route = status === "covered" ? "none" : status === "possible" ? "human" : "test-agent";
        return { requirementId: r.id, status, route, tests: covering, best };
    });

    const conflicts = pairs
        .filter((p) => p.contradicts >= thresholds.covered)
        .map(({ testId, requirementId, contradicts }) => ({ testId, requirementId, contradicts }));
    const conflicted = new Set(conflicts.map((c) => c.testId));
    const orphans = outcomes
        .filter((o) => !o.error && !conflicted.has(o.test.id))
        .map((o) => ({ testId: o.test.id, best: Math.max(0, ...o.pairs.map((p) => p.covers)) }))
        .filter((o) => o.best < thresholds.possible);

    return {
        requirements: coverage,
        conflicts,
        orphans,
        pairs,
        failures,
        truncatedTests: tests.filter((t) => t.truncated).map((t) => t.id),
        usage,
    };
}

/** 2 when some tests could not be judged, 1 when a test conflicts or a requirement is uncovered or only weakly tested, else 0. */
export function coverageExitCode(result: CoverageResult): 0 | 1 | 2 {
    if (result.failures.length > 0) return 2;
    if (result.conflicts.length > 0) return 1;
    if (result.requirements.some((r) => r.status === "uncovered" || r.status === "weak")) return 1;
    return 0;
}
