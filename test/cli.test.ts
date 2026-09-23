import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..");
const cli = join(root, "dist", "cli.js");
const ex = "examples/slugify";

// No API key in the environment: everything here must work, or fail clearly, without one.
const cleanEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const run = (args: string[]) => {
    const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: cleanEnv, cwd: root });
    return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeAll(() => execFileSync("npx", ["tsc"], { cwd: root }));

describe("cli", () => {
    it("prints usage with --help", () => {
        expect(run(["--help"])).toMatchObject({ code: 0 });
        expect(run(["--help"]).out).toContain("Usage:");
    });

    it("dry-runs coverage on the example without a key", () => {
        const r = run(["coverage", "--requirements", `${ex}/requirements.yml`, "--tests", `${ex}/tests`, "--dry-run"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("Would send 5 request(s)");
    });

    it("dry-runs blame on the example, matching both failures to tests and code", () => {
        const r = run(["blame", "--requirements", `${ex}/requirements.yml`, "--tests", `${ex}/tests`, "--junit", `${ex}/results.xml`, "--diff", `${ex}/code.diff`, "--dry-run"]);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("not found");
        expect(r.out.match(/src\/slugify\.ts:1/g)).toHaveLength(2);
    });

    it("dry-runs gaming and weakening without a key or a requirements file", () => {
        const g = run(["gaming", "--diff", `${ex}/gamed.diff`, "--tests", `${ex}/tests`, "--dry-run"]);
        expect(g.code).toBe(0);
        expect(g.out).toContain("special-case, test-aware, swallowed-error");
        const w = run(["weakening", "--diff", `${ex}/weakened.diff`, "--dry-run"]);
        expect(w.code).toBe(0);
        expect(w.out).toContain("loosened-assertion, skipped-test, removed-assertion");
        expect(run(["gaming"]).err).toContain("gaming needs a change");
    });

    it("dry-runs the orchestrator, showing both prompts, and checks the test command", () => {
        const r = run(["run", "--requirements", `${ex}/requirements.yml`, "--test-command", "npx vitest run --reporter=junit --outputFile={junit}", "--dry-run"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("first test-agent prompt");
        expect(r.out).toContain("[max-length]");
        expect(run(["run", "--requirements", `${ex}/requirements.yml`, "--test-command", "npm test"]).err).toContain("{junit}");
    });

    it("dry-runs drift, which needs requirements", () => {
        const d = run(["drift", "--requirements", `${ex}/requirements.yml`, "--diff", `${ex}/drift.diff`, "--dry-run"]);
        expect(d.code).toBe(0);
        expect(d.out).toContain("Would send 5 request(s), one per hunk, each with 7 question(s)");
        expect(run(["drift", "--diff", `${ex}/drift.diff`]).err).toContain("--requirements is required");
    });

    it("fails clearly without a key, and on bad input, before any request", () => {
        const noKey = run(["coverage", "--requirements", `${ex}/requirements.yml`, "--tests", `${ex}/tests`]);
        expect(noKey.code).toBe(2);
        expect(noKey.err).toContain("TYPESAFE_API_KEY");
        expect(run(["lint"]).err).toContain('Unknown command "lint"');
        expect(run(["coverage", "--requirements", `${ex}/requirements.yml`]).err).toContain("--tests is required");
        expect(run(["coverage", "--requirements", "missing.yml", "--tests", ex]).err).toContain("Requirements error");
    });
});
