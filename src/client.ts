import { appendFileSync } from "node:fs";
import { TypeSafeClient, type Questions } from "@typesafe-ai/sdk";

export interface Answer {
    type: string;
    noul?: number;
    choice?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
}

/** Minimal surface of the SDK used here, so tests can inject a fake. */
export interface SystemOneCaller {
    systemOne(request: { state: unknown; questions: Questions }): Promise<{
        answers: Record<string, Answer>;
        usage?: { input_tokens?: number; output_tokens?: number };
    }>;
}

export interface Usage {
    requests: number;
    questions: number;
    inputTokens: number;
    outputTokens: number;
}

export const emptyUsage = (): Usage => ({ requests: 0, questions: 0, inputTokens: 0, outputTokens: 0 });

export type Backend = "typesafe" | "laya";
export const BACKENDS: Backend[] = ["typesafe", "laya"];

export function createClient(backend: Backend = "typesafe", env: NodeJS.ProcessEnv = process.env): SystemOneCaller {
    if (backend === "laya") return new LayaClient(env.LAYA_URL ?? "http://127.0.0.1:8000", env.LAYA_API_KEY);
    if (!env.TYPESAFE_API_KEY) {
        throw new Error("TYPESAFE_API_KEY is not set. Get a key and export it (keep it server-side / in CI secrets).");
    }
    return new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY }) as unknown as SystemOneCaller;
}

/**
 * A local Laya server (laya/server.py), which speaks the same /v1/systemone protocol as TypeSafe.
 * The server refuses input it would have to truncate; that comes back here as an error, so the
 * test or hunk is reported as not judged rather than judged on part of it.
 */
export class LayaClient implements SystemOneCaller {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey?: string,
        private readonly fetchImpl: typeof fetch = fetch
    ) {}

    async systemOne(request: { state: unknown; questions: Questions }) {
        const url = `${this.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
        let res: Response;
        try {
            res = await this.fetchImpl(url, {
                method: "POST",
                headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
                body: JSON.stringify(request),
            });
        } catch (err) {
            throw new Error(`Laya server not reachable at ${this.baseUrl} (start it with: python laya/server.py): ${errorText(err)}`);
        }
        const body = await res.text();
        if (!res.ok) {
            let detail = body;
            try {
                detail = JSON.parse(body).detail ?? body;
            } catch {}
            throw new Error(`Laya ${res.status}: ${detail}`);
        }
        return JSON.parse(body) as Awaited<ReturnType<SystemOneCaller["systemOne"]>>;
    }
}

/**
 * Wraps a client so every request is appended to a JSONL file with its answers (or its error), and
 * `meta` (e.g. the eval case id, whose first segment is the plan). The log is training data for a
 * local model: the exact state and questions, and the probabilities the backend gave.
 */
export function recordingClient(inner: SystemOneCaller, file: string, meta: Record<string, string> = {}): SystemOneCaller {
    return {
        async systemOne(request) {
            const line = (entry: object) => appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...meta, ...request, ...entry }) + "\n");
            try {
                const result = await inner.systemOne(request);
                line({ answers: result.answers, usage: result.usage });
                return result;
            } catch (err) {
                line({ error: errorText(err) });
                throw err;
            }
        },
    };
}

/** Sends one request and adds its cost to `usage`. */
export async function ask(client: SystemOneCaller, usage: Usage, state: unknown, questions: Questions) {
    const result = await client.systemOne({ state, questions });
    usage.requests++;
    usage.questions += Object.keys(questions).length;
    usage.inputTokens += result.usage?.input_tokens ?? 0;
    usage.outputTokens += result.usage?.output_tokens ?? 0;
    return result.answers;
}

export function noulOf(answers: Record<string, Answer>, key: string): number {
    const a = answers[key];
    if (!a || a.type !== "noul" || typeof a.noul !== "number") throw new Error(`No answer for "${key}".`);
    return a.noul;
}

export function choiceOf(answers: Record<string, Answer>, key: string) {
    const a = answers[key];
    if (!a || a.type !== "choice" || typeof a.choice !== "string") throw new Error(`No answer for "${key}".`);
    return { choice: a.choice, confidence: a.confidence ?? 0, probabilities: a.probabilities ?? {} };
}

/** Runs `worker` over items with a fixed concurrency; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return results;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
