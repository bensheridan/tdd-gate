import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git plumbing for the orchestrator. The project repository is the source of truth: accepted
 * turns become commits on a run branch there. Each agent turn happens in a throwaway worktree, so
 * an agent only ever sees what the orchestrator put in front of it, and nothing it does reaches
 * the project until its diff has been filtered and gated.
 */

const git = (cwd: string, args: string[], input?: string) =>
    execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });

export function head(repo: string): string {
    return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function currentBranch(repo: string): string {
    return git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

/** Refuses to start on a dirty tree: the run must not mix with uncommitted work. */
export function assertClean(repo: string): void {
    if (git(repo, ["status", "--porcelain", "--untracked-files=normal"]).trim()) {
        throw new Error(`${repo} has uncommitted changes. Commit or stash them before a run.`);
    }
}

export function createBranch(repo: string, name: string): void {
    git(repo, ["switch", "-q", "-c", name]);
}

export function switchTo(repo: string, branch: string): void {
    git(repo, ["switch", "-q", branch]);
}

export interface Worktree {
    dir: string;
    /** Paths deleted before the agent ran (hidden from it). Their deletion is not the agent's change. */
    hidden: string[];
    /** Paths symlinked in from the project (e.g. node_modules). Never part of the agent's change. */
    linked: string[];
    remove(): void;
}

/** A detached worktree at `ref`, with `hide` paths deleted and `link` paths symlinked from the project. */
export function openWorktree(repo: string, hide: (file: string) => boolean, link: string[] = [], ref = "HEAD"): Worktree {
    const dir = mkdtempSync(join(tmpdir(), "tdd-gate-wt-"));
    git(repo, ["worktree", "add", "-q", "--detach", dir, ref]);
    const hidden = trackedFiles(dir).filter(hide);
    for (const f of hidden) unlinkSync(join(dir, f));
    const linked: string[] = [];
    for (const l of link) {
        if (existsSync(join(repo, l)) && !existsSync(join(dir, l))) {
            symlinkSync(join(repo, l), join(dir, l));
            linked.push(l);
        }
    }
    return {
        dir,
        hidden,
        linked,
        remove: () => {
            try {
                git(repo, ["worktree", "remove", "--force", dir]);
            } catch {
                rmSync(dir, { recursive: true, force: true });
                git(repo, ["worktree", "prune"]);
            }
        },
    };
}

export function trackedFiles(dir: string): string[] {
    return git(dir, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

/** Everything the agent changed in the worktree, as a binary-safe diff against HEAD. */
export function worktreeDiff(wt: Worktree): string {
    git(wt.dir, ["add", "-A"]);
    // Symlinks we created are not the agent's; unstage them if an ignore rule did not already.
    for (const l of wt.linked) git(wt.dir, ["rm", "-q", "--cached", "--ignore-unmatch", "-r", "--", l]);
    // 10 lines of context, as the gates were tuned with (git's default is 3).
    return git(wt.dir, ["diff", "--cached", "--binary", "-U10", "--no-color", "--no-ext-diff", "HEAD"]);
}

export interface FileDiff {
    path: string;
    text: string;
}

/** Splits a git diff into one block per file, keyed by the new path (the old path for deletions). */
export function splitDiff(diff: string): FileDiff[] {
    const blocks: FileDiff[] = [];
    const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
    for (const text of parts) {
        const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
        if (!header) continue;
        const deleted = /^\+\+\+ \/dev\/null$/m.test(text) || /^deleted file mode /m.test(text);
        blocks.push({ path: deleted ? header[1] : header[2], text });
    }
    return blocks;
}

export interface Filtered {
    /** The part of the diff the agent may make. */
    kept: string;
    /** Files the agent changed outside its role; dropped, and reported back to it. */
    dropped: string[];
}

/** Keeps the changes to files the agent owns. Hidden-file deletions and linked paths are never the agent's. */
export function filterDiff(diff: string, owns: (file: string) => boolean, wt: Pick<Worktree, "hidden" | "linked">): Filtered {
    const hidden = new Set(wt.hidden);
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const block of splitDiff(diff)) {
        if (wt.linked.some((l) => block.path === l || block.path.startsWith(`${l}/`))) continue;
        const hiddenDeletion = hidden.has(block.path) && /^deleted file mode /m.test(block.text);
        if (hiddenDeletion) continue;
        if (owns(block.path)) kept.push(block.text);
        else dropped.push(block.path);
    }
    return { kept: kept.join(""), dropped };
}

/** Applies an accepted diff to the project and commits it. Returns the new commit. */
export function applyAndCommit(repo: string, diff: string, message: string): string {
    const patch = join(mkdtempSync(join(tmpdir(), "tdd-gate-patch-")), "turn.patch");
    writeFileSync(patch, diff);
    try {
        git(repo, ["apply", "--index", "--whitespace=nowarn", patch]);
        git(repo, ["-c", "user.name=tdd-gate", "-c", "user.email=tdd-gate@localhost", "commit", "-q", "--no-verify", "-m", message]);
    } finally {
        rmSync(join(patch, ".."), { recursive: true, force: true });
    }
    return head(repo);
}

/** Applies a diff to a worktree's index and files (not committed). */
export function applyToWorktree(dir: string, diff: string): void {
    git(dir, ["apply", "--index", "--whitespace=nowarn", "-"], diff);
}

/** Diff from `base` to the worktree's index: the code as blame would see it after a staged change. */
export function stagedDiffFrom(dir: string, base: string): string {
    return git(dir, ["diff", "--cached", "-U10", "--no-color", "--no-ext-diff", base]);
}

/** Diff of the project between two commits, for blame's view of the code. */
export function diffBetween(repo: string, from: string, to: string = "HEAD"): string {
    return git(repo, ["diff", "-U10", "--no-color", "--no-ext-diff", from, to]);
}
