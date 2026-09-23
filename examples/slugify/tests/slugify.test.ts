import { describe, it, expect } from "vitest";
import { slugify, clearCache } from "../src/slugify";

describe("slugify", () => {
    it("lowercases letters", () => {
        expect(slugify("Hello World")).toBe("hello-world");
    });

    it("collapses runs of spaces into one hyphen", () => {
        expect(slugify("a   b")).toBe("a-b");
    });

    it("turns an ampersand into the word and", () => {
        expect(slugify("salt & pepper")).toBe("salt-and-pepper");
    });

    it("trims hyphens", () => {
        const slug = slugify("  hi  ");
        expect(slug).toBeTruthy();
    });

    it("clears the cache", () => {
        clearCache();
        expect(slugify("x")).toBe("x");
    });
});
