export interface AddedLine {
    line: number;
    text: string;
}

export interface Hunk {
    file: string;
    /** First and last added line numbers in the new file. */
    startLine: number;
    endLine: number;
    addedLines: AddedLine[];
    /** Text of removed lines, so rules can react to a guard being deleted. */
    removedLines: string[];
    /** Hunk rendered for the model: marker, new-file line number, then the code. */
    text: string;
    /** True when the rendered text was cut to fit the size budget, so the tail was not judged. */
    truncated: boolean;
}

export const DEFAULT_MAX_HUNK_CHARS = 12_000;

// Old and new line counts default to 1 when omitted, as in "@@ -3 +3 @@".
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a unified diff into hunks that contain at least one added line.
 * Deleted files and binary files are skipped: there is no new code to judge.
 */
export function parseDiff(diff: string, maxHunkChars: number = DEFAULT_MAX_HUNK_CHARS): Hunk[] {
    const hunks: Hunk[] = [];
    const lines = diff.split("\n");

    let file: string | null = null;
    let skipFile = false;
    let current: { rendered: string[]; added: AddedLine[]; removed: string[]; newLine: number } | null = null;

    const flush = () => {
        if (file && current && current.added.length > 0) {
            let text = current.rendered.join("\n");
            let truncated = false;
            if (text.length > maxHunkChars) {
                text = text.slice(0, maxHunkChars);
                truncated = true;
            }
            hunks.push({
                file,
                startLine: current.added[0].line,
                endLine: current.added[current.added.length - 1].line,
                addedLines: current.added,
                removedLines: current.removed,
                text,
                truncated,
            });
        }
        current = null;
    };

    // Lines still owed to the current hunk, from its "@@ -a,b +c,d @@" header. While a hunk still
    // has lines left, every line is hunk content, even one that looks like a file header
    // ("--- x" is a removed "-- x"; "+++ x" is an added "++ x"). Otherwise a PR author could
    // rename the file mid-hunk and have the rest of it judged (or excluded) under a fake path.
    let oldLeft = 0;
    let newLeft = 0;

    for (const raw of lines) {
        // A hunk body line always starts with a space, "+", "-" or "\\" (an empty line is a context
        // line whose space was stripped). Anything else ends the hunk even if the counts say
        // otherwise, so a wrong count cannot swallow the next file's header.
        const isBodyLine = raw === "" || " +-\\".includes(raw[0]);
        if ((oldLeft > 0 || newLeft > 0) && !isBodyLine) {
            oldLeft = 0;
            newLeft = 0;
        }
        if (oldLeft > 0 || newLeft > 0) {
            const marker = raw[0];
            const body = raw.slice(1);
            if (marker === "\\") continue; // "\ No newline at end of file" is not a diff line
            if (marker === "+") {
                newLeft--;
                if (current) {
                    current.added.push({ line: current.newLine, text: body });
                    current.rendered.push(`+${String(current.newLine).padStart(5)}| ${body}`);
                    current.newLine++;
                }
            } else if (marker === "-") {
                oldLeft--;
                if (current) {
                    current.removed.push(body);
                    current.rendered.push(`-     | ${body}`);
                }
            } else {
                // " " context line; a bare empty line is a context line whose space was stripped.
                oldLeft--;
                newLeft--;
                if (current) {
                    current.rendered.push(` ${String(current.newLine).padStart(5)}| ${body}`);
                    current.newLine++;
                }
            }
            continue;
        }

        if (raw.startsWith("diff --git ")) {
            flush();
            file = null;
            skipFile = false;
            continue;
        }
        if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
            flush();
            skipFile = true;
            continue;
        }
        if (raw.startsWith("+++ ")) {
            const target = raw.slice(4).trim().replace(/^"(.*)"$/, "$1");
            if (target === "/dev/null") {
                skipFile = true;
            } else {
                file = target.replace(/^b\//, "");
            }
            continue;
        }
        if (raw.startsWith("--- ")) continue;

        const header = HUNK_HEADER.exec(raw);
        if (header) {
            flush();
            oldLeft = header[1] === undefined ? 1 : Number(header[1]);
            newLeft = header[3] === undefined ? 1 : Number(header[3]);
            if (!skipFile && file) {
                current = { rendered: [], added: [], removed: [], newLine: Number(header[2]) };
            }
        }
    }
    flush();
    return hunks;
}

/** The text rule triggers are matched against: added lines plus removed lines. */
export function triggerText(hunk: Pick<Hunk, "addedLines" | "removedLines">): string {
    return [...hunk.addedLines.map((l) => l.text), ...hunk.removedLines].join("\n");
}

/**
 * Wraps a snippet as a single-hunk diff, for eval cases. Without `before` the file is new; with
 * `before`, those lines are shown as removed so rules about changed behavior can be tested.
 */
export function snippetToDiff(file: string, code: string, before?: string): string {
    const added = code.replace(/\n$/, "").split("\n");
    const removed = before === undefined ? [] : before.replace(/\n$/, "").split("\n");
    const isNew = before === undefined;
    return [
        `diff --git a/${file} b/${file}`,
        ...(isNew ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${file}`]),
        `+++ b/${file}`,
        `@@ -${isNew ? 0 : 1},${removed.length} +1,${added.length} @@`,
        ...removed.map((l) => `-${l}`),
        ...added.map((l) => `+${l}`),
        "",
    ].join("\n");
}
