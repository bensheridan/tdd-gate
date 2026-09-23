import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface TestCase {
    /** `file::name`, stable across runs while the test keeps its name. */
    id: string;
    file: string;
    name: string;
    line: number;
    /** Source of the test, numbered like the file. */
    code: string;
    truncated: boolean;
}

export const DEFAULT_MAX_TEST_CHARS = 6_000;

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)test_[^/]*\.py$)|(_test\.py$)/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "__pycache__", ".venv", "venv"]);

export const isTestFile = (file: string) => TEST_FILE.test(file.split(sep).join("/"));

// it("name", ...), test('name', ...), it.only(`name`, ...). Parameterised forms (it.each) are left out.
const JS_TEST = /^\s*(?:it|test)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;
const JS_DESCRIBE = /^\s*describe(?:\.(?:only|skip))?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;
const PY_TEST = /^(\s*)(?:async\s+)?def\s+(test_\w+)\s*\(/;

/** Net change in bracket depth on a line, ignoring brackets inside simple string literals and // comments. */
function depthDelta(line: string): number {
    let delta = 0;
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === "\\") i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === "/" && line[i + 1] === "/") break;
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{" || c === "(" || c === "[") delta++;
        else if (c === "}" || c === ")" || c === "]") delta--;
    }
    return delta;
}

const numbered = (lines: string[], from: number) => lines.map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`).join("\n");

function clip(text: string, max: number) {
    return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function extractJs(file: string, lines: string[], max: number): TestCase[] {
    const tests: TestCase[] = [];
    // describe blocks still open, with the depth at which each one closes
    const describes: { name: string; closeDepth: number }[] = [];
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const d = JS_DESCRIBE.exec(line);
        const t = JS_TEST.exec(line);
        if (t) {
            let end = i;
            let inner = 0;
            for (let j = i; j < lines.length; j++) {
                inner += depthDelta(lines[j]);
                end = j;
                if (inner <= 0 && j > i) break;
                if (inner <= 0 && j === i && /\)\s*;?\s*$/.test(lines[j])) break;
            }
            const name = [...describes.map((x) => x.name), t[2]].join(" > ");
            const { text, truncated } = clip(numbered(lines.slice(i, end + 1), i), max);
            tests.push({ id: `${file}::${name}`, file, name, line: i + 1, code: text, truncated });
        }
        const before = depth;
        depth += depthDelta(line);
        if (d && depth > before) describes.push({ name: d[2], closeDepth: before });
        while (describes.length && depth <= describes[describes.length - 1].closeDepth) describes.pop();
    }
    return tests;
}

function extractPy(file: string, lines: string[], max: number): TestCase[] {
    const tests: TestCase[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = PY_TEST.exec(lines[i]);
        if (!m) continue;
        const indent = m[1].length;
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j];
            if (l.trim() === "") continue;
            if (l.length - l.trimStart().length <= indent) break;
            end = j;
        }
        // A test inside a class is named Class::test, as pytest reports it.
        let cls = "";
        for (let k = i - 1; k >= 0 && indent > 0; k--) {
            const c = /^(\s*)class\s+(\w+)/.exec(lines[k]);
            if (c && c[1].length < indent) {
                cls = `${c[2]}::`;
                break;
            }
        }
        const name = `${cls}${m[2]}`;
        const { text, truncated } = clip(numbered(lines.slice(i, end + 1), i), max);
        tests.push({ id: `${file}::${name}`, file, name, line: i + 1, code: text, truncated });
    }
    return tests;
}

/** Finds individual tests in one file's source. Unknown file types yield none. */
export function extractTests(file: string, source: string, max: number = DEFAULT_MAX_TEST_CHARS): TestCase[] {
    const lines = source.replace(/\n$/, "").split("\n");
    if (file.endsWith(".py")) return extractPy(file, lines, max);
    if (/\.[cm]?[jt]sx?$/.test(file)) return extractJs(file, lines, max);
    return [];
}

/** Test files under each path (a file is taken as-is), relative to `cwd`, sorted. */
export function findTestFiles(paths: string[], cwd: string = process.cwd()): string[] {
    const found = new Set<string>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
            } else if (isTestFile(join(dir, entry.name))) {
                found.add(relative(cwd, join(dir, entry.name)).split(sep).join("/"));
            }
        }
    };
    for (const p of paths) {
        const abs = join(cwd, p);
        if (statSync(abs).isDirectory()) walk(abs);
        else found.add(relative(cwd, abs).split(sep).join("/"));
    }
    return [...found].sort();
}

export function loadTests(paths: string[], cwd: string = process.cwd()): TestCase[] {
    return findTestFiles(paths, cwd).flatMap((f) => extractTests(f, readFileSync(join(cwd, f), "utf8")));
}
