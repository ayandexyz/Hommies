/** Read-only helpers over Claude Code's JSONL session transcripts. */
import { readRegularFile } from "./safe-file.js";

/** Transcripts grow for the whole session; recent entries are near the end. */
const tailBytes = 256 * 1024;
/** Claude writes its first `ai-title` within the opening turns. */
const headBytes = 64 * 1024;
const maxTitleLength = 120;

/** Reads the last `tailBytes` of a transcript, or `null` if it is unreadable. */
export async function readTranscriptTail(path: string | undefined): Promise<string | null> {
  return readRange(path, "tail", tailBytes);
}

/**
 * The name Claude shows for a session in `/resume`: a `/rename` title wins over
 * the latest auto-generated one. Searches the tail first, then the head, so
 * long sessions do not need a full read.
 */
export async function readSessionTitle(path: string | undefined): Promise<string | null> {
  const tail = await readRange(path, "tail", tailBytes);
  const fromTail = tail === null ? null : sessionTitle(tail);
  if (fromTail !== null) return fromTail;
  const head = await readRange(path, "head", headBytes);
  return head === null ? null : sessionTitle(head);
}

export function sessionTitle(transcript: string): string | null {
  let custom: string | null = null;
  let generated: string | null = null;
  for (const line of transcript.split("\n")) {
    // Cheap prefilter: most lines are large messages without a title.
    if (!line.includes("-title\"")) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
    if (record.type === "custom-title" && typeof record.customTitle === "string") custom = record.customTitle;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") generated = record.aiTitle;
  }
  const title = (custom ?? generated)?.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > maxTitleLength ? `${title.slice(0, maxTitleLength - 3)}...` : title;
}

/** A bounded read of a regular file; a FIFO or device path yields null instead of blocking. */
async function readRange(path: string | undefined, from: "head" | "tail", bytes: number): Promise<string | null> {
  if (typeof path !== "string") return null;
  // A partial first or last line is cut mid-JSON; callers skip it.
  return readRegularFile(path, bytes, from);
}
