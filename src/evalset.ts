import type { BlameResult } from "./blame.js";
import { judge, type EvalCase, type GateResult, type LabelSource } from "./cases.js";
import type { CoverageResult } from "./coverage.js";
import { GAMING_RULES, WEAKENING_RULES, type DiffGateResult } from "./diffgates.js";
import { mapPool } from "./client.js";
import type { Gates } from "./orchestrate.js";

/** Rules each diff gate can report, so a rule that stayed silent is scored as a negative. */
export const GATE_RULES: Record<"gaming" | "weakening" | "drift", string[]> = {
    gaming: GAMING_RULES.map((r) => r.id),
    weakening: [...WEAKENING_RULES.map((r) => r.id), "deleted-test-file"],
    drift: ["unrequested-behaviour", "untraced"],
};

/** One scored judgment. Binary units have boolean values; categorical ones (route, verdict, status) strings. */
export interface Unit {
    caseId: string;
    source: LabelSource;
    gate: string;
    /** Rule id for diff gates, "conflict" or "status" for coverage, "route" or "verdict" for blame. */
    metric: string;
    /** What the unit is about: a requirement id, a failure name; empty for per-case rules. */
    subject: string;
    expected: boolean | string;
    got: boolean | string;
    probability?: number;
}

export function scoreCase(c: EvalCase, result: GateResult): Unit[] {
    const units: Unit[] = [];
    const base = { caseId: c.id, source: c.labelSource, gate: c.input.gate };
    const e = c.expect;

    if (c.input.gate === "gaming" || c.input.gate === "weakening" || c.input.gate === "drift") {
        if (!e.flagged) return units;
        const r = result as DiffGateResult;
        for (const rule of GATE_RULES[c.input.gate]) {
            const hits = r.findings.filter((f) => f.ruleId === rule);
            units.push({
                ...base,
                metric: rule,
                subject: "",
                expected: e.flagged.includes(rule),
                got: hits.some((f) => f.band === "violation"),
                probability: hits.length ? Math.max(...hits.map((f) => f.probability)) : undefined,
            });
        }
    } else if (c.input.gate === "coverage") {
        const r = result as CoverageResult;
        const conflict = (id: string) => r.conflicts.filter((x) => x.requirementId === id);
        for (const [ids, expected] of [[e.conflicts ?? [], true], [e.noConflicts ?? [], false]] as const) {
            for (const id of ids) {
                const hits = conflict(id);
                units.push({
                    ...base,
                    metric: "conflict",
                    subject: id,
                    expected,
                    got: hits.length > 0,
                    probability: hits.length ? Math.max(...hits.map((h) => h.contradicts)) : undefined,
                });
            }
        }
        for (const [id, status] of Object.entries(e.statuses ?? {})) {
            const got = r.requirements.find((x) => x.requirementId === id);
            units.push({ ...base, metric: "status", subject: id, expected: status, got: got?.status ?? "(missing)" });
        }
    } else {
        const r = result as BlameResult;
        for (const f of c.input.failures) {
            const b = r.blames.find((x) => x.failure === f.name);
            if (e.route) units.push({ ...base, metric: "route", subject: f.name, expected: e.route, got: b?.route ?? "(missing)", probability: b?.confidence });
            if (e.verdict) units.push({ ...base, metric: "verdict", subject: f.name, expected: e.verdict, got: b?.verdict ?? "(none)", probability: b?.confidence });
        }
    }
    return units;
}

export interface Metric {
    gate: string;
    metric: string;
    source: LabelSource | "all";
    /** Binary metrics. */
    tp?: number;
    fp?: number;
    fn?: number;
    tn?: number;
    precision?: number | null;
    recall?: number | null;
    /** Categorical metrics. */
    correct?: number;
    total: number;
    confusion?: Record<string, Record<string, number>>;
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

export function summarise(units: Unit[]): Metric[] {
    const groups = new Map<string, Unit[]>();
    for (const u of units) {
        for (const source of [u.source, "all"] as const) {
            const key = `${u.gate}\t${u.metric}\t${source}`;
            groups.set(key, [...(groups.get(key) ?? []), u]);
        }
    }
    const out: Metric[] = [];
    for (const [key, us] of groups) {
        const [gate, metric, source] = key.split("\t") as [string, string, LabelSource | "all"];
        if (typeof us[0].expected === "boolean") {
            const tp = us.filter((u) => u.expected && u.got).length;
            const fp = us.filter((u) => !u.expected && u.got).length;
            const fn = us.filter((u) => u.expected && !u.got).length;
            const tn = us.filter((u) => !u.expected && !u.got).length;
            out.push({ gate, metric, source, tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), total: us.length });
        } else {
            const confusion: Record<string, Record<string, number>> = {};
            for (const u of us) {
                const row = (confusion[String(u.expected)] ??= {});
                row[String(u.got)] = (row[String(u.got)] ?? 0) + 1;
            }
            out.push({ gate, metric, source, correct: us.filter((u) => u.expected === u.got).length, total: us.length, confusion });
        }
    }
    const order = ["coverage", "blame", "gaming", "weakening", "drift"];
    return out.sort((a, b) => order.indexOf(a.gate) - order.indexOf(b.gate) || a.metric.localeCompare(b.metric) || a.source.localeCompare(b.source));
}

export interface EvalRun {
    cases: number;
    scored: number;
    unlabeled: EvalCase[];
    units: Unit[];
    metrics: Metric[];
    /** Cases whose gate call failed: missing, not negative. */
    errors: { caseId: string; error: string }[];
    /** Results per case id, for listing unlabeled cases with what the gate says now. */
    results: Map<string, GateResult>;
}

/**
 * Re-runs the current gates on every case (or uses the recorded output with `recorded: true`)
 * and scores the labeled ones. Unlabeled cases are judged too, so a reviewer sees today's output.
 */
export async function runEvalSet(cases: EvalCase[], gatesFor: (c: EvalCase) => Gates, options: { recorded?: boolean; concurrency?: number } = {}): Promise<EvalRun> {
    const results = new Map<string, GateResult>();
    const errors: EvalRun["errors"] = [];
    await mapPool(cases, options.concurrency ?? 4, async (c) => {
        try {
            if (options.recorded) {
                if (!c.recorded) throw new Error("no recorded result");
                results.set(c.id, c.recorded);
            } else {
                results.set(c.id, await judge(gatesFor(c), c.input));
            }
        } catch (err) {
            errors.push({ caseId: c.id, error: err instanceof Error ? err.message : String(err) });
        }
    });
    const labeled = cases.filter((c) => c.labelSource !== "unlabeled" && results.has(c.id));
    const units = labeled.flatMap((c) => scoreCase(c, results.get(c.id)!));
    return {
        cases: cases.length,
        scored: labeled.length,
        unlabeled: cases.filter((c) => c.labelSource === "unlabeled"),
        units,
        metrics: summarise(units),
        errors,
        results,
    };
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "  -  " : `${(x * 100).toFixed(0).padStart(3)}%`);

export function formatEvalRun(run: EvalRun): string {
    const out: string[] = [];
    out.push(`${run.cases} case(s): ${run.scored} labeled and scored, ${run.unlabeled.length} unlabeled, ${run.errors.length} not judged.\n`);
    const sources = new Set(run.units.map((u) => u.source));
    for (const source of ["construction", "review", "all"] as const) {
        // With a single label source, "all" would repeat it.
        if (source === "all" && sources.size < 2) continue;
        const ms = run.metrics.filter((m) => m.source === source);
        if (!ms.length) continue;
        out.push(`== ${source === "all" ? "all labels" : `${source} labels`} ==`);
        for (const m of ms) {
            if (m.tp !== undefined) {
                out.push(
                    `${m.gate.padEnd(10)} ${m.metric.padEnd(22)} TP ${String(m.tp).padStart(3)}  FP ${String(m.fp).padStart(3)}  FN ${String(m.fn).padStart(3)}  TN ${String(m.tn).padStart(3)}   precision ${pct(m.precision)}  recall ${pct(m.recall)}`
                );
            } else {
                out.push(`${m.gate.padEnd(10)} ${m.metric.padEnd(22)} ${m.correct}/${m.total} correct (${pct(ratio(m.correct!, m.total))})`);
                for (const [exp, row] of Object.entries(m.confusion ?? {})) {
                    const wrong = Object.entries(row).filter(([got]) => got !== exp);
                    if (wrong.length) out.push(`${"".padEnd(34)}expected ${exp}: got ${wrong.map(([g, n]) => `${g} x${n}`).join(", ")}`);
                }
            }
        }
        out.push("");
    }
    const misses = run.units.filter((u) => u.expected !== u.got);
    if (misses.length) {
        out.push("== misses ==");
        for (const u of misses) {
            const what = typeof u.expected === "boolean" ? (u.expected ? "missed" : "false alarm") : `expected ${u.expected}, got ${u.got}`;
            out.push(`${u.caseId}  [${u.gate} ${u.metric}${u.subject ? ` ${u.subject}` : ""}] ${what}${u.probability !== undefined ? ` (p=${u.probability.toFixed(2)})` : ""}`);
        }
        out.push("");
    }
    for (const e of run.errors) out.push(`NOT JUDGED ${e.caseId}: ${e.error}`);
    if (run.unlabeled.length) out.push(`Unlabeled cases are listed with --unlabeled; label one by setting "expect" and "labelSource": "review" in its file.`);
    return out.join("\n");
}

/** What the gate says now about each unlabeled case, compactly, for a reviewer. */
export function formatUnlabeled(run: EvalRun): string {
    const out: string[] = [];
    for (const c of run.unlabeled) {
        const r = run.results.get(c.id);
        let said = "(not judged)";
        if (r && "findings" in r) said = r.findings.map((f) => `${f.ruleId}=${f.probability.toFixed(2)}${f.band === "possible" ? "?" : ""}`).join(", ") || "clean";
        else if (r && "requirements" in r) said = `${r.requirements.map((x) => `${x.requirementId}:${x.status}`).join(" ")}${r.conflicts.length ? ` conflicts: ${r.conflicts.map((x) => x.requirementId).join(",")}` : ""}`;
        else if (r && "blames" in r) said = r.blames.map((b) => `${b.failure} -> ${b.route}`).join("; ");
        out.push(`${c.id}  [${c.input.gate}] ${said}`);
    }
    return out.join("\n");
}
