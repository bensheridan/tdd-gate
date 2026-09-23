import { describe, it, expect, vi } from "vitest";
import type { SystemOneCaller } from "../src/client.js";
import { snippetToDiff } from "../src/diff.js";
import { diffExitCode } from "../src/diffgates.js";
import { buildDriftQuestions, checkDrift } from "../src/drift.js";
import { parsePlan } from "../src/requirements.js";

const plan = parsePlan(`
requirements:
  - {id: lower, text: output is lowercase}
  - {id: strip, text: punctuation is removed}
`);

const diff = (...files: string[]) => files.map((f) => snippetToDiff(f, `export const ${f.replace(/\W/g, "_")} = 1;`)).join("");

// Per file: [extra, housekeeping, need_lower, need_strip]
function fake(byFile: Record<string, [number, number, number, number]>): SystemOneCaller {
    return {
        systemOne: vi.fn(async ({ state }: any) => {
            const [extra, housekeeping, n0, n1] = byFile[state.file];
            const answers: Record<string, any> = {
                extra: { type: "noul", noul: extra },
                housekeeping: { type: "noul", noul: housekeeping },
                need_0: { type: "noul", noul: n0 },
                need_1: { type: "noul", noul: n1 },
            };
            return { answers, usage: { input_tokens: 7, output_tokens: 1 } };
        }),
    };
}

describe("buildDriftQuestions", () => {
    it("asks extra, housekeeping and one need per requirement", () => {
        const q = buildDriftQuestions(plan.requirements) as Record<string, any>;
        expect(Object.keys(q)).toEqual(["extra", "housekeeping", "need_0", "need_1"]);
        expect(JSON.stringify(q.need_1.instructions)).toContain("punctuation is removed");
    });
});

describe("checkDrift", () => {
    it("flags unrequested behaviour, traces hunks to requirements, and ignores test files", async () => {
        const client = fake({
            "src/cache.ts": [0.95, 0.1, 0.1, 0.1],
            "src/mixed.ts": [0.9, 0.1, 0.9, 0.2],
            "src/lower.ts": [0.1, 0.1, 0.95, 0.1],
            "src/maybe.ts": [0.5, 0.1, 0.8, 0.1],
        });
        const r = await checkDrift(client, diff("src/cache.ts", "src/mixed.ts", "src/lower.ts", "src/maybe.ts", "tests/x.test.ts"), plan);
        expect(client.systemOne).toHaveBeenCalledTimes(4);
        expect(r.findings.map((f) => [f.file, f.ruleId, f.band, f.route])).toEqual([
            ["src/cache.ts", "unrequested-behaviour", "violation", "code-agent"],
            ["src/mixed.ts", "unrequested-behaviour", "violation", "code-agent"],
            ["src/maybe.ts", "unrequested-behaviour", "possible", "human"],
        ]);
        expect(r.findings[1].message).toContain("also serves lower");
        expect(r.trace!.map((t) => [t.file, t.requirements])).toEqual([
            ["src/cache.ts", []],
            ["src/mixed.ts", ["lower"]],
            ["src/lower.ts", ["lower"]],
            ["src/maybe.ts", ["lower"]],
        ]);
        expect(r.usage.questions).toBe(16);
        expect(diffExitCode(r)).toBe(1);
    });

    it("reports untraced code as a warning for a person, and exempts housekeeping", async () => {
        const client = fake({
            "src/dead.ts": [0.2, 0.1, 0.1, 0.2],
            "src/index.ts": [0.2, 0.45, 0.1, 0.1],
            "src/moved.ts": [0.8, 0.9, 0.1, 0.1],
        });
        const r = await checkDrift(client, diff("src/dead.ts", "src/index.ts", "src/moved.ts"), plan);
        expect(r.findings.map((f) => [f.file, f.ruleId, f.severity, f.route])).toEqual([["src/dead.ts", "untraced", "warning", "human"]]);
        expect(diffExitCode(r)).toBe(0);
    });

    it("records request failures instead of passing the hunk", async () => {
        const client: SystemOneCaller = { systemOne: vi.fn(async () => { throw new Error("boom"); }) };
        const r = await checkDrift(client, diff("src/a.ts"), plan);
        expect(r.failures).toEqual([{ file: "src/a.ts", startLine: 1, error: "boom" }]);
        expect(r.trace).toEqual([]);
        expect(diffExitCode(r)).toBe(2);
    });
});
