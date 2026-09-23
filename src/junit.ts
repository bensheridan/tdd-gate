import { readFileSync } from "node:fs";

/**
 * A failed test from a JUnit XML report. Vitest (--reporter=junit), Jest (jest-junit) and pytest
 * (--junitxml) all write this format, so failures can be read without a parser per runner.
 */
export interface TestFailure {
    name: string;
    classname: string;
    file?: string;
    message: string;
}

export const DEFAULT_MAX_MESSAGE_CHARS = 2_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
            if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
            return ENTITIES[e] ?? m;
        });
}

function attributes(source: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of source.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[3] ?? m[4] ?? "");
    return out;
}

export function parseJunit(xml: string, maxMessageChars: number = DEFAULT_MAX_MESSAGE_CHARS): TestFailure[] {
    const failures: TestFailure[] = [];
    for (const tc of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
        const body = tc[2];
        if (!body) continue;
        const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
        if (!f) continue;
        const attrs = attributes(tc[1]);
        const fAttrs = attributes(f[2]);
        const detail = decode(f[3] ?? "").trim();
        const message = [fAttrs.message, detail].filter((s) => s && s.trim()).join("\n").trim() || `(${f[1]} with no message)`;
        failures.push({
            name: attrs.name ?? "",
            classname: attrs.classname ?? "",
            file: attrs.file,
            message: message.length > maxMessageChars ? message.slice(0, maxMessageChars) : message,
        });
    }
    return failures;
}

export function loadJunit(path: string): TestFailure[] {
    return parseJunit(readFileSync(path === "-" ? 0 : path, "utf8"));
}
