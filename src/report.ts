import type { BlameResult } from "./blame.js";
import type { Usage } from "./client.js";
import type { CoverageResult } from "./coverage.js";
import type { DiffGateResult } from "./diffgates.js";

const p = (n: number) => n.toFixed(2);
const usageLine = (u: Usage) => `${u.requests} request(s), ${u.questions} question(s). Tokens: ${u.inputTokens} in, ${u.outputTokens} out.`;

export function formatCoverage(result: CoverageResult): string {
    const out: string[] = [];
    for (const r of result.requirements) {
        const tag = r.status.toUpperCase().padEnd(9);
        const route = r.route === "none" ? "" : `  -> ${r.route}`;
        out.push(`${tag} ${r.requirementId}  (best p(covers)=${p(r.best)})${route}`);
        for (const t of r.tests) out.push(`            ${t.testId}  covers=${p(t.covers)} asserts=${p(t.asserts)}`);
    }
    for (const c of result.conflicts) out.push(`CONFLICT  ${c.testId}  expects what ${c.requirementId} rules out (p=${p(c.contradicts)})  -> test-agent`);
    for (const o of result.orphans) out.push(`ORPHAN    ${o.testId}  matches no requirement (best ${p(o.best)})  -> test-agent`);
    for (const f of result.failures) out.push(`NOT JUDGED ${f.testId}  ${f.error}`);
    for (const t of result.truncatedTests) out.push(`TRUNCATED ${t}  test source exceeded the size budget; its tail was not judged`);

    const count = (s: string) => result.requirements.filter((r) => r.status === s).length;
    out.push(
        `\n${count("covered")} covered, ${count("weak")} weak, ${count("possible")} possible, ${count("uncovered")} uncovered; ` +
            `${result.conflicts.length} conflicting test(s), ${result.orphans.length} orphan test(s), ${result.failures.length} test(s) not judged. ${usageLine(result.usage)}`
    );
    return out.join("\n");
}

export function formatBlame(result: BlameResult): string {
    const out: string[] = [];
    for (const b of result.blames) {
        const where = b.hunk ? `  code ${b.hunk.file}:${b.hunk.startLine}-${b.hunk.endLine}` : "";
        const verdict = b.verdict ? ` ${b.verdict} (confidence ${p(b.confidence ?? 0)})` : "";
        out.push(`-> ${b.route.padEnd(10)} ${b.failure}${b.requirementId ? `  [${b.requirementId}]` : ""}${verdict}${where}`);
        out.push(`             ${b.reason}`);
    }
    out.push(`\n${result.blames.length} failure(s), ${result.failures.length} not judged. ${usageLine(result.usage)}`);
    return out.join("\n");
}

export function formatDiffGate(result: DiffGateResult): string {
    const out: string[] = [];
    for (const f of result.findings) {
        const tag = f.band === "possible" ? "POSSIBLE" : f.severity === "warning" ? "WARNING" : "VIOLATION";
        const where = f.endLine > f.startLine ? `${f.file}:${f.startLine}-${f.endLine}` : `${f.file}:${f.startLine}`;
        out.push(`${tag.padEnd(9)} ${where}  [${f.ruleId}] ${f.message}  -> ${f.route}`);
        if (f.testLiterals) out.push(`          uses values from the tests: ${f.testLiterals.map((s) => JSON.stringify(s)).join(", ")}`);
    }
    for (const f of result.failures) out.push(`NOT JUDGED ${f.file}:${f.startLine}  ${f.error}`);
    for (const t of result.truncated) out.push(`TRUNCATED ${t.file}:${t.startLine}  hunk exceeded the size budget; its tail was not judged`);
    if (result.trace) {
        out.push("\ntrace:");
        for (const t of result.trace) out.push(`  ${t.file}:${t.startLine}-${t.endLine}  ${t.requirements.join(", ") || "(none)"}`);
    }
    const count = (band: string) => result.findings.filter((f) => f.band === band).length;
    out.push(
        `\n${result.gate}: ${count("violation")} flagged, ${count("possible")} possible, ${result.failures.length} hunk(s) not judged. ` +
            `${result.stats.hunksJudged} hunk(s) judged, ${result.stats.skipped} skipped because no rule applies. ${usageLine(result.usage)}`
    );
    return out.join("\n");
}

export const formatJson = (result: unknown) => JSON.stringify(result, null, 2);
