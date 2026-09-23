import { describe, it, expect } from "vitest";
import { extractTests, isTestFile } from "../src/tests.js";

describe("extractTests (JS/TS)", () => {
    const src = `import { it } from "vitest";
describe("outer", () => {
    describe("inner", () => {
        it("does a thing", () => {
            const s = "}";
            expect(f({ a: 1 })).toBe(1);
        });
    });
    test('one liner', () => expect(1).toBe(1));
});
it(\`top level\`, async () => {
    await g();
});
`;
    const tests = extractTests("a.test.ts", src);

    it("names tests with their describe blocks", () => {
        expect(tests.map((t) => t.name)).toEqual(["outer > inner > does a thing", "outer > one liner", "top level"]);
        expect(tests[0].id).toBe("a.test.ts::outer > inner > does a thing");
    });

    it("captures the whole body, numbered like the file, ignoring brackets in strings", () => {
        expect(tests[0].line).toBe(4);
        expect(tests[0].code).toContain("    6|");
        expect(tests[0].code).toContain("    7|         });");
        expect(tests[0].code).not.toContain("describe");
        expect(tests[1].code.split("\n")).toHaveLength(1);
        expect(tests[2].code).toContain("await g()");
    });
});

describe("extractTests (Python)", () => {
    const src = `import pytest

def test_plain():
    assert f(1) == 2

    assert f(2) == 3

class TestThing:
    def test_method(self):
        assert True

def helper():
    pass
`;
    it("finds functions and methods, stopping at the dedent", () => {
        const tests = extractTests("tests/test_x.py", src);
        expect(tests.map((t) => t.name)).toEqual(["test_plain", "TestThing::test_method"]);
        expect(tests[0].code).toContain("assert f(2) == 3");
        expect(tests[0].code).not.toContain("class");
    });
});

describe("isTestFile", () => {
    it("recognises common conventions", () => {
        expect(["a.test.ts", "src/b.spec.jsx", "tests/test_c.py", "d_test.py"].every(isTestFile)).toBe(true);
        expect(["src/a.ts", "testing.py", "contest.ts"].some(isTestFile)).toBe(false);
    });
});
