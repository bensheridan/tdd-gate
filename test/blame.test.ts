import { describe, it, expect, vi } from "vitest";
import { blameExitCode, blameFailures, buildLocateQuestions, candidateHunks, matchTest } from "../src/blame.js";
import type { SystemOneCaller } from "../src/client.js";
import { parseDiff, snippetToDiff } from "../src/diff.js";
import { parsePlan } from "../src/requirements.js";
import { extractTests } from "../src/tests.js";

const plan = parsePlan(`
requirements:
  - {id: lower, text: output is lowercase}
  - {id: strip, text: punctuation is removed}
`);
const tests = extractTests(
    "tests/s.test.ts",
    `describe("slugify", () => {
    it("lowercases", () => { expect(slugify("A")).toBe("a"); });
    it("ampersand", () => { expect(slugify("a&b")).toBe("a-and-b"); });
});
`
);
const hunks = [
    ...parseDiff(snippetToDiff("src/other.ts", "export const unrelated = 1;")),
    ...parseDiff(snippetToDiff("src/slugify.ts", "export function slugify(s) { return s.toLowerCase(); }")),
    ...parseDiff(snippetToDiff("tests/s.test.ts", "it('x', () => slugify('y'))")),
];
const failure = (name: string) => ({ name, classname: "tests/s.test.ts", message: "expected 'ab' to be 'a-and-b'" });

const choice = (label: string, confidence: number) => ({ type: "choice", choice: label, confidence, probabilities: { [label]: confidence } });

// covers / contradicts are per requirement, in plan order: [lower, strip]
function fake(locate: { covers: number[]; contradicts?: number[]; hunk?: [string, number] }, verdict?: [string, number]): SystemOneCaller {
    return {
        systemOne: vi.fn(async ({ questions }: any) => {
            if (questions.verdict) return { answers: { verdict: choice(...verdict!) } };
            const answers: Record<string, any> = {};
            locate.covers.forEach((p, i) => {
                answers[`cover_${i}`] = { type: "noul", noul: p };
                answers[`contradict_${i}`] = { type: "noul", noul: locate.contradicts?.[i] ?? 0.05 };
            });
            if (questions.hunk) answers.hunk = choice(...(locate.hunk ?? ["none", 0.9]));
            return { answers };
        }),
    };
}

describe("matchTest", () => {
    it("matches Vitest, jest-junit and bare names", () => {
        expect(matchTest(failure("slugify > ampersand"), tests)?.name).toBe("slugify > ampersand");
        expect(matchTest({ name: "slugify ampersand", classname: "", message: "" }, tests)?.name).toBe("slugify > ampersand");
        expect(matchTest({ name: "ampersand", classname: "", message: "" }, tests)?.name).toBe("slugify > ampersand");
        expect(matchTest({ name: "nope", classname: "", message: "" }, tests)).toBeUndefined();
    });

    it("uses a runner path relative to another root", () => {
        const deep = extractTests("pkg/tests/s.test.ts", `it("a", () => {});`);
        const other = extractTests("pkg/other/s.test.ts", `it("a", () => {});`);
        expect(matchTest({ name: "a", classname: "tests/s.test.ts", message: "" }, [...other, ...deep])?.file).toBe("pkg/tests/s.test.ts");
    });
});

describe("candidateHunks", () => {
    it("leaves out test files and ranks by shared identifiers", () => {
        const c = candidateHunks(tests[1], hunks);
        expect(c.map((h) => h.file)).toEqual(["src/slugify.ts", "src/other.ts"]);
        expect(candidateHunks(tests[1], hunks, 1).map((h) => h.file)).toEqual(["src/slugify.ts"]);
    });
});

describe("buildLocateQuestions", () => {
    it("asks the coverage gate's target questions per requirement, and offers every hunk plus none", () => {
        const q = buildLocateQuestions(plan.requirements, hunks.slice(0, 2)) as Record<string, any>;
        expect(Object.keys(q).sort()).toEqual(["contradict_0", "contradict_1", "cover_0", "cover_1", "hunk"]);
        expect(Object.keys(q.hunk.criteria)).toEqual(["h0", "h1", "none"]);
        expect(q.hunk.criteria.h1).toContain("src/slugify.ts");
    });
});

describe("blameFailures", () => {
    it("routes a confident test_wrong verdict to the test agent, with the selected hunk", async () => {
        const client = fake({ covers: [0.1, 0.9], hunk: ["h0", 0.8] }, ["test_wrong", 0.85]);
        const r = await blameFailures(client, plan, [failure("slugify > ampersand")], tests, hunks);
        expect(client.systemOne).toHaveBeenCalledTimes(2);
        expect(r.blames[0]).toMatchObject({ requirementId: "strip", verdict: "test_wrong", route: "test-agent", hunk: { file: "src/slugify.ts" } });
        expect(blameExitCode(r)).toBe(0);
    });

    it("routes code_wrong to the code agent, and says when no code implements it", async () => {
        const client = fake({ covers: [0.9, 0.1], hunk: ["none", 0.9] }, ["code_wrong", 0.9]);
        const r = await blameFailures(client, plan, [failure("slugify > lowercases")], tests, hunks);
        expect(r.blames[0]).toMatchObject({ verdict: "code_wrong", route: "code-agent", hunk: undefined });
        const verdictState = (client.systemOne as any).mock.calls[1][0].state;
        expect(verdictState.code).toMatch(/No code/);
        expect(verdictState.requirement).toBe("output is lowercase");
    });

    it("sends low confidence, ambiguity and unknown tests to a person", async () => {
        const low = await blameFailures(fake({ covers: [0.1, 0.9] }, ["code_wrong", 0.4]), plan, [failure("slugify > ampersand")], tests, hunks);
        expect(low.blames[0]).toMatchObject({ verdict: "code_wrong", route: "human" });
        const amb = await blameFailures(fake({ covers: [0.1, 0.9] }, ["ambiguous", 0.9]), plan, [failure("slugify > ampersand")], tests, hunks);
        expect(amb.blames[0].route).toBe("human");
        const unsure = await blameFailures(fake({ covers: [0.1, 0.5] }), plan, [failure("slugify > ampersand")], tests, hunks);
        expect(unsure.blames[0].route).toBe("human");
        expect(unsure.blames[0].verdict).toBeUndefined();
        const client = fake({ covers: [0.1, 0.9] });
        const missing = await blameFailures(client, plan, [failure("nope")], tests, hunks);
        expect(missing.blames[0].route).toBe("human");
        expect(client.systemOne).not.toHaveBeenCalled();
        expect(blameExitCode(missing)).toBe(1);
    });

    it("sends a test that matches no requirement back to the test agent without a verdict request", async () => {
        const client = fake({ covers: [0.1, 0.2] });
        const r = await blameFailures(client, plan, [failure("slugify > ampersand")], tests, hunks);
        expect(r.blames[0].route).toBe("test-agent");
        expect(r.blames[0].requirementId).toBeUndefined();
        expect(client.systemOne).toHaveBeenCalledTimes(1);
    });

    it("settles a test that contradicts a requirement as test_wrong without a verdict request", async () => {
        const client = fake({ covers: [0.1, 0.2], contradicts: [0.05, 0.95] });
        const r = await blameFailures(client, plan, [failure("slugify > ampersand")], tests, hunks);
        expect(r.blames[0]).toMatchObject({ requirementId: "strip", verdict: "test_wrong", confidence: 0.95, route: "test-agent" });
        expect(client.systemOne).toHaveBeenCalledTimes(1);
    });

    it("records request failures and routes them to a person", async () => {
        const client: SystemOneCaller = { systemOne: vi.fn(async () => { throw new Error("boom"); }) };
        const r = await blameFailures(client, plan, [failure("slugify > ampersand")], tests, hunks);
        expect(r.failures).toEqual([{ failure: "slugify > ampersand", error: "boom" }]);
        expect(r.blames[0].route).toBe("human");
        expect(blameExitCode(r)).toBe(2);
    });
});
