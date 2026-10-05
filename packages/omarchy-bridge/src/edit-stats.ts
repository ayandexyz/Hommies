/**
 * Line counts for file edits, worked out in the adapter so only two numbers
 * reach the bridge: the edited text and file contents never leave the agent.
 */
import { isAbsolute, resolve } from "node:path";

import { readRegularFile } from "./safe-file.js";
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

/** The whole file when it is a regular file of at most `maxFileBytes`, checked on the open descriptor. */
const readSmallFile = (path: string): Promise<string | null> => readRegularFile(path, maxFileBytes, "whole");

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
/** One old/new replacement: Claude `Edit`, OpenCode `edit`, Gemini CLI `replace`, Grok `search_replace`, Antigravity `replace_file_content`. */
const replaceTools = new Set(["edit", "replace", "search_replace", "replace_file_content"]);
/** Several replacements in one file: Claude `MultiEdit`, Antigravity `multi_replace_file_content`. */
const multiReplaceTools = new Set(["multiedit", "multi_replace_file_content"]);
/** A whole file: Claude and OpenCode `Write`, Gemini CLI `write_file`, Antigravity `write_to_file`. */
const writeTools = new Set(["write", "write_file", "write_to_file"]);

export interface EditStatsOptions {
  /**
   * The tool already ran (Antigravity reports tools after the fact), so the
   * file on disk holds the new content: a write that replaced a file cannot be
   * counted, and a new file is all additions.
   */
  readonly afterRun?: boolean;
}

export async function editStats(toolName: string, toolInput: unknown, cwd?: string, options: EditStatsOptions = {}): Promise<EditStats | null> {
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
    // Gemini CLI says how many occurrences it expects to replace.
    const expected = typeof edit.expected_replacements === "number" && Number.isSafeInteger(edit.expected_replacements) && edit.expected_replacements > 1
      ? edit.expected_replacements : 1;
    if (edit.replace_all !== true && edit.replaceAll !== true) return { added: stats.added * expected, removed: stats.removed * expected };
    // After the run the old text is gone from the file, so it counts once.
    const contents = options.afterRun ? null : await fileText();
    const times = contents === null ? 1 : Math.max(1, occurrences(contents, before));
    return { added: stats.added * times, removed: stats.removed * times };
  };

  const write = async (content: string): Promise<EditStats> => {
    if (!options.afterRun) return lineDiff((await current()) ?? "", content);
    return lineDiff("", content);
  };

  // Grok's search_replace creates a file when old_string is empty.
  if (tool === "search_replace" && text(input, "old_string", "oldString") === "") {
    const content = text(input, "new_string", "newString");
    return content === null ? null : write(content);
  }
  if (replaceTools.has(tool)) return replace(input, current);
  if (multiReplaceTools.has(tool)) {
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
  if (writeTools.has(tool)) {
    const content = text(input, "content");
    if (content === null) return null;
    // After the run, an overwrite's old content is gone: no honest count.
    if (options.afterRun && input.overwrite === true) return null;
    return write(content);
  }
  // Codex `apply_patch` (also run through its shell tool) and OpenCode `patch`.
  const patch = text(input, "patch", "patchText", "input", "command");
  return patch === null ? null : patchStats(patch);
}
