import { describe, it, expect, vi } from "vitest";
import { buildCoverageQuestions, checkCoverage, coverageExitCode } from "../src/coverage.js";
import type { SystemOneCaller } from "../src/client.js";
import { parsePlan } from "../src/requirements.js";
import { extractTests } from "../src/tests.js";

const plan = parsePlan(`
requirements:
  - {id: r0, text: behaviour zero}
  - {id: r1, text: behaviour one}
  - {id: r2, text: behaviour two}
  - {id: r3, text: behaviour three}
`);
const tests = extractTests("a.test.ts", `it("t0", () => {});\nit("t1", () => {});\nit("t2", () => {});\n`);
const withConflict = [...tests, ...extractTests("a.test.ts", `it("t3", () => {});`)];

// [covers, asserts, contradicts] per requirement, per test name
const table: Record<string, [number, number, number][]> = {
    t0: [[0.95, 0.9, 0.1], [0.1, 0.9, 0.1], [0.8, 0.2, 0.1], [0.1, 0.1, 0.1]],
    t1: [[0.2, 0.2, 0.1], [0.5, 0.5, 0.1], [0.1, 0.1, 0.1], [0.1, 0.1, 0.1]],
    t2: [[0.1, 0.1, 0.1], [0.1, 0.1, 0.1], [0.1, 0.1, 0.1], [0.2, 0.9, 0.1]],
    t3: [[0.1, 0.1, 0.1], [0.1, 0.1, 0.1], [0.1, 0.1, 0.1], [0.9, 0.9, 0.85]],
};

function fake(fail?: string): SystemOneCaller {
    return {
        systemOne: vi.fn(async ({ state }: any) => {
            if (state.test.name === fail) throw new Error("boom");
            const answers: Record<string, any> = {};
            table[state.test.name].forEach(([c, a, x], i) => {
                answers[`cover_${i}`] = { type: "noul", noul: c };
                answers[`assert_${i}`] = { type: "noul", noul: a };
                answers[`contradict_${i}`] = { type: "noul", noul: x };
            });
            return { answers, usage: { input_tokens: 10, output_tokens: 1 } };
        }),
    };
}

describe("buildCoverageQuestions", () => {
    it("asks covers, asserts and contradicts for each requirement, carrying its text", () => {
        const q = buildCoverageQuestions(plan.requirements) as Record<string, any>;
        expect(Object.keys(q)).toHaveLength(12);
        expect(JSON.stringify(q.contradict_1.instructions)).toContain("behaviour one");
        expect(JSON.stringify(q.cover_2.instructions)).toContain("behaviour two");
        expect(JSON.stringify(q.assert_2.instructions)).toContain("Assume");
    });
});

describe("checkCoverage", () => {
    it("builds statuses, routes and orphans from per-pair probabilities", async () => {
        const client = fake();
        const result = await checkCoverage(client, tests, plan);
        expect(client.systemOne).toHaveBeenCalledTimes(3);
        expect(result.requirements.map((r) => [r.requirementId, r.status, r.route])).toEqual([
            ["r0", "covered", "none"],
            ["r1", "possible", "human"],
            ["r2", "weak", "test-agent"],
            ["r3", "uncovered", "test-agent"],
        ]);
        expect(result.requirements[0].tests).toEqual([{ testId: "a.test.ts::t0", covers: 0.95, asserts: 0.9 }]);
        expect(result.orphans).toEqual([{ testId: "a.test.ts::t2", best: 0.2 }]);
        expect(result.conflicts).toEqual([]);
        expect(result.usage).toEqual({ requests: 3, questions: 36, inputTokens: 30, outputTokens: 3 });
        expect(coverageExitCode(result)).toBe(1);
    });

    it("reports a contradicting test as a conflict, not as coverage or an orphan", async () => {
        const result = await checkCoverage(fake(), withConflict, plan);
        expect(result.conflicts).toEqual([{ testId: "a.test.ts::t3", requirementId: "r3", contradicts: 0.85 }]);
        expect(result.requirements[3]).toMatchObject({ status: "uncovered", tests: [] });
        expect(result.orphans.map((o) => o.testId)).toEqual(["a.test.ts::t2"]);
    });

    it("records a failed test instead of treating it as covering nothing", async () => {
        const result = await checkCoverage(fake("t2"), tests, plan, { concurrency: 1 });
        expect(result.failures).toEqual([{ testId: "a.test.ts::t2", error: "boom" }]);
        expect(result.orphans).toEqual([]);
        expect(coverageExitCode(result)).toBe(2);
    });
});
