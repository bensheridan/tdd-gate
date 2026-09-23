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
        const r = run(["blame", "--requirements", `${ex}/requirements.yml`, "--tests", `${ex}/tests`, "--junit", `${ex}/results.xml`, "--code-diff", `${ex}/code.diff`, "--dry-run"]);
        expect(r.code).toBe(0);
        expect(r.out).not.toContain("not found");
        expect(r.out.match(/src\/slugify\.ts:1/g)).toHaveLength(2);
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
