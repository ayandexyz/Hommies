/**
 * Read-only helpers over freecode's session store
 * (`~/.freecode/sessions/<formatted-cwd>/<sessionId>/`). freecode's hooks
 * carry no transcript-path field (unlike Claude/Codex), so sessions are
 * resolved from `session_id` + `cwd` directly.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readRegularFile } from "./safe-file.js";

/** meta.json is tiny; this is just a generous ceiling. */
const metaMaxBytes = 64 * 1024;
/** messages.jsonl grows for the whole session; the last assistant text is near the end. */
const messagesTailBytes = 256 * 1024;
const maxTitleLength = 120;

const PATH_SEP = "-";
const HYPHEN_ESCAPE = "_h_";
const SEGMENT_SEP = "__";

/**
 * Ported verbatim from freecode's `apps/core/src/store/path-formatter.ts`
 * (`formatSessionDirName`) — pure and small enough to copy rather than share
 * a package across two unrelated repos. Keep in sync if freecode's version
 * changes; `findFreecodeSessionDir`'s directory-scan fallback covers a drift.
 */
export function formatSessionDirName(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/");
  const stripped = normalized.replace(/^\/+|\/+$/g, "");
  if (!stripped) return "";
  return stripped
    .split("/")
    .map((segment) => segment.replace(/-/g, HYPHEN_ESCAPE).replace(/[<>:"|?*]/g, ""))
    .join(SEGMENT_SEP);
}

const freecodeSessionsDir = (): string => join(homedir(), ".freecode", "sessions");

/**
 * The session's directory, or `null` if it cannot be found. Tries the
 * formatted `cwd` first; falls back to scanning every project directory for
 * one containing `sessionId` (freecode's own store does the same fallback),
 * in case `cwd` doesn't exactly match what freecode formatted it from.
 */
async function findFreecodeSessionDir(cwd: string | undefined, sessionId: string): Promise<string | null> {
  const sessionsDir = freecodeSessionsDir();
  if (typeof cwd === "string" && cwd.length > 0) {
    const direct = join(sessionsDir, formatSessionDirName(cwd), sessionId);
    if (await hasEntry(direct)) return direct;
  }
  try {
    for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(sessionsDir, entry.name, sessionId);
      if (await hasEntry(candidate)) return candidate;
    }
  } catch {
    // No sessions directory yet.
  }
  return null;
}

async function hasEntry(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}

export async function readFreecodeSessionTitle(cwd: string | undefined, sessionId: string | undefined): Promise<string | null> {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const dir = await findFreecodeSessionDir(cwd, sessionId);
  if (dir === null) return null;
  const raw = await readRegularFile(join(dir, "meta.json"), metaMaxBytes, "whole");
  if (raw === null) return null;
  let meta: unknown;
  try { meta = JSON.parse(raw); } catch { return null; }
  if (meta === null || typeof meta !== "object") return null;
  const title = (meta as { title?: unknown }).title;
  if (typeof title !== "string") return null;
  const flat = title.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > maxTitleLength ? `${flat.slice(0, maxTitleLength - 3)}...` : flat;
}

interface SerializedMessagePart {
  readonly type?: unknown;
  readonly content?: unknown;
}

interface SerializedMessage {
  readonly role?: unknown;
  readonly parts?: ReadonlyArray<SerializedMessagePart>;
}

/** Joins a message's text parts, same shape freecode's own `previewOf` reads. */
function textOf(message: SerializedMessage): string | null {
  if (!Array.isArray(message.parts)) return null;
  const text = message.parts
    .flatMap((part) => (part.type === "text" && typeof part.content === "string" ? [part.content] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** The last assistant turn's text from `messages.jsonl`, or `null` if there isn't one. */
export async function lastFreecodeAssistantText(cwd: string | undefined, sessionId: string | undefined): Promise<string | null> {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const dir = await findFreecodeSessionDir(cwd, sessionId);
  if (dir === null) return null;
  const tail = await readRegularFile(join(dir, "messages.jsonl"), messagesTailBytes, "tail");
  if (tail === null) return null;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    const message = entry as SerializedMessage;
    if (message.role !== "assistant") continue;
    const text = textOf(message);
    if (text !== null) return text;
  }
  return null;
}
