import { describe, it, expect } from "vitest";
import { parseJunit } from "../src/junit.js";

describe("parseJunit", () => {
    it("returns failures and errors only, decoding entities and CDATA", () => {
        const xml = `<testsuites><testsuite>
  <testcase classname="t/a.test.ts" name="s &gt; ok" time="0"/>
  <testcase classname="t/a.test.ts" name="s &gt; bad"><failure message="expected &apos;x&apos;">trace &amp; more</failure></testcase>
  <testcase classname="tests.test_b" name="test_err" file="tests/test_b.py"><error message="boom"><![CDATA[Traceback <here>]]></error></testcase>
  <testcase classname="c" name="skipped"><skipped/></testcase>
</testsuite></testsuites>`;
        expect(parseJunit(xml)).toEqual([
            { name: "s > bad", classname: "t/a.test.ts", file: undefined, message: "expected 'x'\ntrace & more" },
            { name: "test_err", classname: "tests.test_b", file: "tests/test_b.py", message: "boom\nTraceback <here>" },
        ]);
    });

    it("truncates long messages", () => {
        const xml = `<testcase name="t"><failure message="${"x".repeat(50)}"/></testcase>`;
        expect(parseJunit(xml, 10)[0].message).toBe("x".repeat(10));
    });
});
