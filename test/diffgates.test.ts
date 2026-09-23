import { describe, it, expect, vi } from "vitest";
import type { SystemOneCaller } from "../src/client.js";
import { deletedFiles, parseDiff, snippetToDiff } from "../src/diff.js";
import { applicableDiffRules, buildDiffQuestions, checkDiff, diffExitCode, gateHunks, testLiterals, GAMING_RULES } from "../src/diffgates.js";
import { DEFAULT_THRESHOLDS } from "../src/requirements.js";
import { extractTests } from "../src/tests.js";

const t = DEFAULT_THRESHOLDS;
const codeDiff = snippetToDiff("src/a.ts", 'export const f = (s) => s === "magic input" ? "x" : s;\ntry { g(); } catch { }');
const testDiff = snippetToDiff("tests/a.test.ts", 'it.skip("x", () => expect(f(1)).toBeTruthy());', 'it("x", () => expect(f(1)).toBe(2));');
const addOnlyTest = snippetToDiff("tests/b.test.ts", 'it("y", () => expect(f(1)).toBe(2));');
const deletion = `diff --git a/tests/c.test.ts b/tests/c.test.ts
deleted file mode 100644
index 1111111..0000000
--- a/tests/c.test.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-it("z", () => expect(1).toBe(1));
`;
const removalOnly = `diff --git a/tests/a.test.ts b/tests/a.test.ts
--- a/tests/a.test.ts
+++ b/tests/a.test.ts
@@ -4,3 +4,2 @@
 keep
-    expect(f(2)).toBe(3);
 keep2
`;

// Answers every rule_i with the probability for that rule id.
function fake(byRule: Record<string, number>, rulesAsked: string[][] = []): SystemOneCaller {
    return {
        systemOne: vi.fn(async ({ questions }: any) => {
            const ids = Object.values(questions).map((q: any) => q.instructions.rule.title as string);
            rulesAsked.push(ids);
            const answers: Record<string, any> = {};
            ids.forEach((title, i) => (answers[`rule_${i}`] = { type: "noul", noul: byRule[title] ?? 0.05 }));
            return { answers, usage: { input_tokens: 5, output_tokens: 1 } };
        }),
    };
}

describe("diff parsing for the gates", () => {
    it("keeps removal-only hunks only when asked, anchored at the change", () => {
        expect(parseDiff(removalOnly)).toEqual([]);
        const [h] = parseDiff(removalOnly, undefined, true);
        expect(h).toMatchObject({ file: "tests/a.test.ts", startLine: 5, endLine: 5, addedLines: [] });
        expect(h.removedLines).toEqual(["    expect(f(2)).toBe(3);"]);
    });

    it("finds deleted files", () => {
        expect(deletedFiles(deletion + codeDiff)).toEqual(["tests/c.test.ts"]);
    });

    it("gives gaming the code and weakening the tests", () => {
        const both = codeDiff + testDiff;
        expect(gateHunks("gaming", both).map((h) => h.file)).toEqual(["src/a.ts"]);
        expect(gateHunks("weakening", both).map((h) => h.file)).toEqual(["tests/a.test.ts"]);
    });
});

describe("applicableDiffRules", () => {
    it("asks removal rules only when lines were removed, and triggered rules only on a match", () => {
        const [changed] = gateHunks("weakening", testDiff);
        expect(applicableDiffRules("weakening", changed).map((r) => r.id)).toEqual(["loosened-assertion", "skipped-test", "removed-assertion"]);
        const [added] = gateHunks("weakening", addOnlyTest);
        expect(applicableDiffRules("weakening", added)).toEqual([]);
        const [code] = gateHunks("gaming", codeDiff);
        expect(applicableDiffRules("gaming", code).map((r) => r.id)).toEqual(["special-case", "swallowed-error"]);
    });
});

describe("buildDiffQuestions", () => {
    it("carries the rule condition and the gate's task", () => {
        const q = buildDiffQuestions("gaming", GAMING_RULES) as Record<string, any>;
        expect(Object.keys(q)).toEqual(["rule_0", "rule_1", "rule_2"]);
        expect(JSON.stringify(q.rule_0.instructions)).toContain("strings_also_in_tests");
        expect(q.rule_0.instructions.task).toContain("make a test suite pass");
    });
});

describe("testLiterals", () => {
    it("collects string literals from test code, not line numbers or test titles", () => {
        const tests = extractTests("a.test.ts", 'it("title here", () => {\n    expect(f("magic input")).toBe("out");\n});');
        const lits = testLiterals(tests);
        expect(lits.has("magic input")).toBe(true);
        expect(lits.has("out")).toBe(true);
        expect(lits.has("title here")).toBe(false);
    });
});

describe("checkDiff", () => {
    it("flags gaming, routes it to the code agent, and attaches literals shared with the tests", async () => {
        const tests = extractTests("tests/a.test.ts", 'it("t", () => {\n    expect(f("magic input")).toBe("x");\n});');
        const client = fake({ "Special-cased input": 0.9, "Error swallowed": 0.5 });
        const r = await checkDiff(client, "gaming", codeDiff, t, { tests });
        expect(r.findings.map((f) => [f.ruleId, f.band, f.route])).toEqual([
            ["special-case", "violation", "code-agent"],
            ["swallowed-error", "possible", "human"],
        ]);
        expect(r.findings[0].testLiterals).toEqual(["magic input"]);
        const state = (client.systemOne as any).mock.calls[0][0].state;
        expect(state.strings_also_in_tests).toEqual(["magic input"]);
        expect(diffExitCode(r)).toBe(1);
    });

    it("routes weakening to the test agent, removed assertions and deleted files to a person", async () => {
        const client = fake({ "Test skipped or disabled": 0.95, "Assertion or test removed": 0.9 });
        const r = await checkDiff(client, "weakening", deletion + testDiff, t);
        expect(r.findings.map((f) => [f.ruleId, f.route])).toEqual([
            ["deleted-test-file", "human"],
            ["skipped-test", "test-agent"],
            ["removed-assertion", "human"],
        ]);
        expect(diffExitCode(r)).toBe(1);
    });

    it("does not fail on warnings alone", async () => {
        const r = await checkDiff(fake({}), "weakening", deletion, t);
        expect(r.findings.map((f) => f.ruleId)).toEqual(["deleted-test-file"]);
        expect(diffExitCode(r)).toBe(0);
    });

    it("sends nothing when no rule applies, and records request failures", async () => {
        const quiet = fake({});
        const none = await checkDiff(quiet, "weakening", addOnlyTest, t);
        expect(quiet.systemOne).not.toHaveBeenCalled();
        expect(none.stats).toMatchObject({ hunks: 1, hunksJudged: 0, skipped: 1 });

        const broken: SystemOneCaller = { systemOne: vi.fn(async () => { throw new Error("boom"); }) };
        const r = await checkDiff(broken, "gaming", codeDiff, t);
        expect(r.failures).toEqual([{ file: "src/a.ts", startLine: 1, error: "boom" }]);
        expect(diffExitCode(r)).toBe(2);
    });
});
