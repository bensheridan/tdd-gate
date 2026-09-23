import { readFileSync } from "node:fs";
import { load } from "js-yaml";

export interface Requirement {
    id: string;
    /** One testable behaviour, written as the exact condition. This text is what the model judges against. */
    text: string;
}

export interface Thresholds {
    /** p(test exercises requirement) at or above which the pair counts as covered. */
    covered: number;
    /** At or above this, but below `covered`, the pair is reported as "possible" for a person to look at. */
    possible: number;
    /** p(assertions would catch a broken implementation) at or above which a covering test counts as strong. */
    strong: number;
    /** Choice confidence below which a failure is routed to a person instead of an agent. */
    route: number;
}

export interface Plan {
    requirements: Requirement[];
    thresholds: Thresholds;
}

// Starting points, not validated values. Measure on your own history before trusting them.
export const DEFAULT_THRESHOLDS: Thresholds = { covered: 0.7, possible: 0.35, strong: 0.6, route: 0.6 };

export class PlanError extends Error {}

const unit = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 && value <= 1 ? value : fallback);

export function parsePlan(source: string): Plan {
    let doc: any;
    try {
        doc = load(source);
    } catch (err) {
        throw new PlanError(`Requirements file is not valid YAML: ${(err as Error).message}`);
    }
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.requirements) || doc.requirements.length === 0) {
        throw new PlanError('Requirements file must contain a non-empty "requirements" list.');
    }

    const seen = new Set<string>();
    const requirements: Requirement[] = doc.requirements.map((r: any, i: number) => {
        const id = typeof r?.id === "string" ? r.id.trim() : "";
        if (!id) throw new PlanError(`Requirement #${i + 1} is missing an "id".`);
        if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new PlanError(`Requirement id "${id}" may only use letters, digits, "_", "." and "-".`);
        if (id === "none") throw new PlanError('"none" is reserved and cannot be a requirement id.');
        if (seen.has(id)) throw new PlanError(`Duplicate requirement id "${id}".`);
        seen.add(id);
        if (typeof r.text !== "string" || !r.text.trim()) {
            throw new PlanError(`Requirement "${id}" needs a "text" that states one testable behaviour.`);
        }
        return { id, text: r.text.trim().replace(/\s+/g, " ") };
    });

    const t = doc.thresholds ?? {};
    const covered = unit(t.covered, DEFAULT_THRESHOLDS.covered);
    const possible = Math.min(unit(t.possible, DEFAULT_THRESHOLDS.possible), covered);
    return {
        requirements,
        thresholds: { covered, possible, strong: unit(t.strong, DEFAULT_THRESHOLDS.strong), route: unit(t.route, DEFAULT_THRESHOLDS.route) },
    };
}

export function loadPlan(path: string): Plan {
    let source: string;
    try {
        source = readFileSync(path, "utf8");
    } catch (err) {
        throw new PlanError(`Cannot read requirements file "${path}": ${(err as Error).message}`);
    }
    return parsePlan(source);
}
