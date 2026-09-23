import { spawn } from "node:child_process";
import type { Requirement } from "./requirements.js";

export type Role = "test-agent" | "code-agent";

/** Anything that can take a prompt and edit files in a directory. */
export interface Agent {
    run(prompt: string, cwd: string): Promise<void>;
}

/** Default: Claude Code in print mode, allowed to read and edit files only (no shell). */
export const DEFAULT_AGENT_COMMAND = "claude -p --permission-mode acceptEdits --allowedTools Read,Write,Edit,Glob,Grep";

/**
 * Runs a shell command in the worktree with the prompt on stdin. Any agent CLI that reads a prompt
 * from stdin and edits files in its working directory works (Claude Code, Codex, aider, ...).
 */
export function commandAgent(command: string, options: { timeoutMs?: number; log?: (line: string) => void } = {}): Agent {
    return {
        run: (prompt, cwd) =>
            new Promise((resolve, reject) => {
                const child = spawn(command, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
                let stderr = "";
                const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 15 * 60_000);
                child.stdout.on("data", (d) => options.log?.(String(d)));
                child.stderr.on("data", (d) => (stderr += String(d)));
                child.on("error", (err) => {
                    clearTimeout(timer);
                    reject(err);
                });
                child.on("close", (code, signal) => {
                    clearTimeout(timer);
                    if (code === 0) resolve();
                    else reject(new Error(`Agent command exited with ${signal ?? code}: ${stderr.trim().slice(-500)}`));
                });
                child.stdin.end(prompt);
            }),
    };
}

const list = (requirements: Requirement[]) => requirements.map((r) => `- [${r.id}] ${r.text}`).join("\n");

const feedbackBlock = (feedback: string[]) =>
    feedback.length === 0
        ? ""
        : `\n\nA reviewer checked your previous work against the requirements and sent it back. Fix each point:\n${feedback.map((f) => `- ${f}`).join("\n")}`;

export function testAgentPrompt(requirements: Requirement[], feedback: string[], testHint: string, testCommand?: string): string {
    return `You are the test agent in a test-driven workflow. Write tests for the requirements below. A separate agent writes the implementation; you do not.

Rules:
- Only create or edit test files (${testHint}). Changes to any other file are discarded.${
        testCommand ? `
- The tests are run with \`${testCommand.replaceAll("{junit}", "<report>")}\`. Use that runner's API (imports, test functions, assertions).` : ""
    }
- Write at least one test per requirement. Assert the exact result each requirement describes; do not settle for checks that any output would pass.
- Do not test behaviour the requirements do not ask for.
- Do not skip, loosen or delete tests to make them pass.

Requirements:
${list(requirements)}${feedbackBlock(feedback)}
`;
}

export function codeAgentPrompt(requirements: Requirement[], feedback: string[]): string {
    return `You are the code agent in a test-driven workflow. Implement the requirements below. A separate agent writes the tests; you cannot see them and must not write tests.

Rules:
- Only create or edit implementation files. Test files you create are discarded.
- Implement exactly what the requirements say, for all inputs. Do not special-case particular inputs, detect test environments, or swallow errors.
- Do not add behaviour the requirements do not ask for (caching, logging, extra options or exports).

Requirements:
${list(requirements)}${feedbackBlock(feedback)}
`;
}
