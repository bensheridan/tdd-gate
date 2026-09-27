import { describe, it, expect } from "vitest";
import { noul } from "@typesafe-ai/sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, LayaClient, recordingClient, type SystemOneCaller } from "../src/client.js";

const questions = { q: noul("Is it?", { true: "yes", false: "no" }) };

describe("LayaClient", () => {
    it("posts the request to /v1/systemone and returns the Jev-shaped answers", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fake = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 60, output_tokens: 0 } }));
        }) as unknown as typeof fetch;
        const client = new LayaClient("http://localhost:9000/", "k", fake);
        const result = await client.systemOne({ state: { a: 1 }, questions });
        expect(result.answers.q.noul).toBe(0.8);
        expect(calls[0].url).toBe("http://localhost:9000/v1/systemone");
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ state: { a: 1 }, questions });
        expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    });

    it("turns a refused request (e.g. input too long) into an error, so it is not judged", async () => {
        const fake = (async () => new Response(JSON.stringify({ detail: "input does not fit Laya's token budget" }), { status: 422 })) as unknown as typeof fetch;
        await expect(new LayaClient("http://x", undefined, fake).systemOne({ state: {}, questions })).rejects.toThrow(/Laya 422: input does not fit/);
    });

    it("says how to start the server when it is not running", async () => {
        const fake = (async () => {
            throw new TypeError("fetch failed");
        }) as unknown as typeof fetch;
        await expect(new LayaClient("http://x", undefined, fake).systemOne({ state: {}, questions })).rejects.toThrow(/python laya\/server.py/);
    });

    it("needs no TypeSafe key", () => {
        expect(createClient("laya", {})).toBeInstanceOf(LayaClient);
        expect(() => createClient("typesafe", {})).toThrow(/TYPESAFE_API_KEY/);
    });
});

describe("recordingClient", () => {
    const log = () => join(mkdtempSync(join(tmpdir(), "tdd-gate-log-")), "requests.jsonl");
    const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

    it("appends each request with its answers, usage and meta, and passes the result through", async () => {
        const file = log();
        const inner: SystemOneCaller = { systemOne: async () => ({ answers: { q: { type: "noul", noul: 0.3 } }, usage: { input_tokens: 5 } }) };
        const client = recordingClient(inner, file, { caseId: "cart/x", gate: "gaming" });
        const result = await client.systemOne({ state: { s: 1 }, questions });
        await client.systemOne({ state: { s: 2 }, questions });
        expect(result.answers.q.noul).toBe(0.3);
        const [first, second] = lines(file);
        expect(first).toMatchObject({ caseId: "cart/x", gate: "gaming", state: { s: 1 }, questions, answers: { q: { noul: 0.3 } }, usage: { input_tokens: 5 } });
        expect(second.state).toEqual({ s: 2 });
    });

    it("records a failed request with its error and still throws", async () => {
        const file = log();
        const inner: SystemOneCaller = {
            systemOne: async () => {
                throw new Error("boom");
            },
        };
        await expect(recordingClient(inner, file).systemOne({ state: {}, questions })).rejects.toThrow("boom");
        expect(lines(file)[0]).toMatchObject({ error: "boom", questions });
        expect(lines(file)[0].answers).toBeUndefined();
    });
});
