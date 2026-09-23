import { describe, it, expect } from "vitest";
import { parsePlan, PlanError, DEFAULT_THRESHOLDS } from "../src/requirements.js";

describe("parsePlan", () => {
    it("reads requirements and fills default thresholds", () => {
        const plan = parsePlan("requirements:\n  - {id: a, text: 'does   a\t thing'}\n");
        expect(plan.requirements).toEqual([{ id: "a", text: "does a thing" }]);
        expect(plan.thresholds).toEqual(DEFAULT_THRESHOLDS);
    });

    it("keeps possible at or below covered", () => {
        const plan = parsePlan("thresholds: {covered: 0.5, possible: 0.9}\nrequirements: [{id: a, text: x}]");
        expect(plan.thresholds.possible).toBe(0.5);
    });

    it.each([
        ["requirements: []", /non-empty/],
        ["requirements: [{text: x}]", /missing an "id"/],
        ["requirements: [{id: a, text: x}, {id: a, text: y}]", /Duplicate/],
        ["requirements: [{id: none, text: x}]", /reserved/],
        ["requirements: [{id: 'a b', text: x}]", /may only use/],
        ["requirements: [{id: a}]", /needs a "text"/],
    ])("rejects %s", (src, message) => {
        expect(() => parsePlan(src)).toThrow(PlanError);
        expect(() => parsePlan(src)).toThrow(message);
    });
});
