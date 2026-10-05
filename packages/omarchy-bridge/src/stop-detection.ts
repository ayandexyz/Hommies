/**
 * Decides whether a Claude turn that ended without a tool call is waiting on
 * the user (a plain-text question or decision) rather than finished.
 *
 * Claude Code's `Stop` hook fires for both cases, so this is a heuristic over
 * the final assistant message. It deliberately looks only at the closing
 * paragraph: a question in the middle of a long report is usually rhetorical,
 * while one at the end is what the user has to answer.
 */

const maxSummaryLength = 320;

const askingPattern = new RegExp(
  [
    "\\bshould i\\b",
    "\\bshall i\\b",
    "\\bdo you want\\b",
    "\\bwould you like\\b",
    "\\bwant me to\\b",
    "\\bwhich (?:one|option|approach|do you|would you)\\b",
    "\\blet me know (?:if|whether|which|how|what)\\b",
    "\\bplease (?:confirm|choose|pick|decide|advise)\\b",
    "\\bwaiting (?:for|on) your\\b",
    "\\byour call\\b",
  ].join("|"),
  "i",
);

/**
 * Returns a short summary of what Claude is asking, or `null` when the final
 * message reads as a completed turn.
 */
export function detectReplyRequest(message: string): string | null {
  const paragraph = closingParagraph(message);
  if (paragraph === null) return null;
  const lines = paragraph.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const lastLine = lines[lines.length - 1] ?? "";
  const endsWithQuestion = /\?[)"'*_`]*$/.test(lastLine);
  if (!endsWithQuestion && !askingPattern.test(paragraph)) return null;
  return summarize(paragraph);
}

/**
 * Extracts the text of the final assistant message from a Claude Code JSONL
 * transcript. One assistant turn can span several lines (one per content
 * block), so the text blocks after the last non-assistant entry are joined.
 */
export function lastAssistantText(transcript: string): string | null {
  const lines = transcript.split("\n");
  const texts: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; message?: { content?: unknown } };
    if (record.type !== "assistant") {
      // Metadata lines (summaries, system notices) do not end the turn.
      if (record.type === "user") break;
      continue;
    }
    const content = record.message?.content;
    if (typeof content === "string") texts.unshift(content);
    else if (Array.isArray(content)) {
      const blockTexts = content.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object") return [];
        const value = block as { type?: unknown; text?: unknown };
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      });
      if (blockTexts.length > 0) texts.unshift(blockTexts.join("\n"));
    }
  }
  const text = texts.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** Longest final message kept on a turn-end item, so one long report cannot bloat `/v1/pending`. */
export const maxMessageLength = 4000;

/**
 * The final message to show in full under a turn-end item, or null when it
 * adds nothing to the one-line `summary`. Long messages are cut at a line break.
 */
export function finalMessage(message: string, summary: string): string | null {
  const text = message.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0 || text.replace(/\s+/g, " ") === summary) return null;
  if (text.length <= maxMessageLength) return text;
  const cut = text.slice(0, maxMessageLength - 1);
  const lineEnd = cut.lastIndexOf("\n");
  return `${(lineEnd > maxMessageLength / 2 ? cut.slice(0, lineEnd) : cut).trimEnd()}\n\u2026`;
}

/** A one-line preview of a finished turn: the opening paragraph, flattened. */
export function summarizeFinishedTurn(message: string): string {
  const prose = message.replace(/```[\s\S]*?(?:```|$)/g, "\n\n").trim();
  const first = prose.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).find((paragraph) => paragraph.length > 0);
  const flat = (first ?? "").replace(/\s+/g, " ").replace(/[*_`#>]+/g, "").trim();
  if (flat.length === 0) return "Claude finished this turn";
  return flat.length > maxSummaryLength ? `${flat.slice(0, maxSummaryLength - 3)}...` : flat;
}

function closingParagraph(message: string): string | null {
  // Code blocks are output, not prose; a `?` inside one is not a question.
  const prose = message.replace(/```[\s\S]*?(?:```|$)/g, "\n\n").trim();
  const paragraphs = prose.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph.length > 0);
  return paragraphs[paragraphs.length - 1] ?? null;
}

function summarize(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, " ").replace(/[*_`]+/g, "").trim();
  // Prefer the last sentence ending in "?", which is the actual ask.
  const questions = flat.match(/[^.!?]*\?/g);
  const summary = (questions?.[questions.length - 1] ?? flat).trim();
  return summary.length > maxSummaryLength ? `${summary.slice(0, maxSummaryLength - 3)}...` : summary;
}
