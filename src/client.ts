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

export function createClient(env: NodeJS.ProcessEnv = process.env): SystemOneCaller {
    if (!env.TYPESAFE_API_KEY) {
        throw new Error("TYPESAFE_API_KEY is not set. Get a key and export it (keep it server-side / in CI secrets).");
    }
    return new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY }) as unknown as SystemOneCaller;
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
