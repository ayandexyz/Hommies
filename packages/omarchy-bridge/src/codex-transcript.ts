/** Read-only helpers over Codex's rollout files and session index. */
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The index is append-only and small; renames land at the end. */
const indexTailBytes = 256 * 1024;
const maxTitleLength = 120;

/**
 * Extracts the final assistant message from a Codex rollout JSONL. Assistant
 * text is stored as `response_item` → `message` (role `assistant`) with
 * `output_text` blocks. Codex also writes commentary between tool calls as
 * assistant messages, so collection stops at the last tool call or output.
 */
export function lastCodexAssistantText(rollout: string): string | null {
  const lines = rollout.split("\n");
  const texts: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; payload?: { type?: unknown; role?: unknown; content?: unknown } };
    if (record.type !== "response_item") continue;
    if (record.payload?.type !== "message") {
      if (texts.length > 0 && typeof record.payload?.type === "string" && record.payload.type.includes("call")) break;
      continue;
    }
    if (record.payload.role === "user") break;
    if (record.payload.role !== "assistant" || !Array.isArray(record.payload.content)) continue;
    const blockTexts = record.payload.content.flatMap((block: unknown) => {
      if (block === null || typeof block !== "object") return [];
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "output_text" && typeof value.text === "string" ? [value.text] : [];
    });
    if (blockTexts.length > 0) texts.unshift(blockTexts.join("\n"));
  }
  const text = texts.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** The latest `thread_name` recorded for a session in `session_index.jsonl`. */
export function codexSessionTitle(index: string, sessionId: string): string | null {
  let title: string | null = null;
  for (const line of index.split("\n")) {
    if (!line.includes(sessionId)) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; thread_name?: unknown };
    if (record.id === sessionId && typeof record.thread_name === "string") title = record.thread_name;
  }
  const flat = title?.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > maxTitleLength ? `${flat.slice(0, maxTitleLength - 3)}...` : flat;
}

export async function readCodexSessionTitle(sessionId: string | undefined): Promise<string | null> {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    const file = await open(join(codexHome, "session_index.jsonl"), "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, indexTailBytes);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return codexSessionTitle(buffer.toString("utf8"), sessionId);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
