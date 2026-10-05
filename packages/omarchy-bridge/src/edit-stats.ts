/**
 * Line counts for file edits, worked out in the adapter so only two numbers
 * reach the bridge: the edited text and file contents never leave the agent.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { EditStats } from "./types.js";

/** Larger files are not read; `Write` then counts its new lines only. */
const maxFileBytes = 1024 * 1024;
/** Above this many line pairs, unmatched lines count as changed instead of running an LCS. */
const maxLcsCells = 4_000_000;
/** Patches start with this line (Codex `apply_patch`, OpenCode `patch`). */
const patchMarker = "*** Begin Patch";

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Lines added and removed going from `before` to `after`, like `git diff --numstat`. */
export function lineDiff(before: string, after: string): EditStats {
  const old = splitLines(before);
  const next = splitLines(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) { oldEnd--; nextEnd--; }
  const removed = oldEnd - start;
  const added = nextEnd - start;
  if (removed === 0 || added === 0 || removed * added > maxLcsCells) return { added, removed };
  // Longest common subsequence length over the changed middle, two rows at a time.
  let previous = new Uint32Array(added + 1);
  let current = new Uint32Array(added + 1);
  for (let row = 1; row <= removed; row++) {
    const line = old[start + row - 1];
    for (let column = 1; column <= added; column++) {
      current[column] = line === next[start + column - 1]
        ? previous[column - 1]! + 1
        : Math.max(previous[column]!, current[column - 1]!);
    }
    [previous, current] = [current, previous];
  }
  const common = previous[added]!;
  return { added: added - common, removed: removed - common };
}

/** Counts `+` and `-` lines in an `*** Begin Patch` block. */
export function patchStats(patch: string): EditStats | null {
  const begin = patch.indexOf(patchMarker);
  if (begin < 0) return null;
  let added = 0;
  let removed = 0;
  for (const line of patch.slice(begin).split("\n")) {
    if (line.startsWith("*** End Patch")) break;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > maxFileBytes) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function occurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  for (let index = text.indexOf(search); index >= 0; index = text.indexOf(search, index + search.length)) count++;
  return count;
}

const text = (input: Readonly<Record<string, unknown>>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return null;
};

/**
 * Lines a tool call is about to add and remove, or null when it is not an edit.
 * Takes Claude's snake_case and OpenCode's camelCase argument names. Reads the
 * target file only for `Write` and `replace_all` edits, and only when it is small.
 */
export async function editStats(toolName: string, toolInput: unknown, cwd?: string): Promise<EditStats | null> {
  if (toolInput === null || typeof toolInput !== "object") return null;
  const input = toolInput as Readonly<Record<string, unknown>>;
  const tool = toolName.toLowerCase();
  const filePath = text(input, "file_path", "filePath");
  const absolute = filePath === null ? null : isAbsolute(filePath) || cwd === undefined ? filePath : resolve(cwd, filePath);
  const current = async (): Promise<string | null> => absolute === null ? null : readSmallFile(absolute);

  const replace = async (edit: Readonly<Record<string, unknown>>, fileText: () => Promise<string | null>): Promise<EditStats | null> => {
    const before = text(edit, "old_string", "oldString");
    const after = text(edit, "new_string", "newString");
    if (before === null || after === null) return null;
    const stats = lineDiff(before, after);
    if (edit.replace_all !== true && edit.replaceAll !== true) return stats;
    const contents = await fileText();
    const times = contents === null ? 1 : Math.max(1, occurrences(contents, before));
    return { added: stats.added * times, removed: stats.removed * times };
  };

  if (tool === "edit") return replace(input, current);
  if (tool === "multiedit") {
    if (!Array.isArray(input.edits)) return null;
    let contents: Promise<string | null> | undefined;
    const fileText = (): Promise<string | null> => (contents ??= current());
    let added = 0;
    let removed = 0;
    for (const edit of input.edits) {
      if (edit === null || typeof edit !== "object") continue;
      const stats = await replace(edit as Readonly<Record<string, unknown>>, fileText);
      if (stats === null) continue;
      added += stats.added;
      removed += stats.removed;
    }
    return { added, removed };
  }
  if (tool === "write") {
    const content = text(input, "content");
    if (content === null) return null;
    return lineDiff((await current()) ?? "", content);
  }
  // Codex `apply_patch` (also run through its shell tool) and OpenCode `patch`.
  const patch = text(input, "patch", "patchText", "input", "command");
  return patch === null ? null : patchStats(patch);
}
