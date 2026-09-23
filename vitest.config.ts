import { defineConfig } from "vitest/config";

// examples/ holds deliberately failing tests for the demo; only run this project's own.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
