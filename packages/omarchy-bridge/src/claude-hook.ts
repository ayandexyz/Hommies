/** Command-hook adapter for Claude Code questions, permissions, and turn ends. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { lastAssistantText } from "./stop-detection.js";
import { readSessionTitle, readTranscriptTail } from "./transcript.js";

interface PortFile { readonly port: number; readonly token: string; }

interface HookEvent {
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly transcript_path?: string;
  readonly stop_hook_active?: boolean;
  readonly last_assistant_message?: string;
}

async function main(): Promise<void> {
  const input = await readStdin();
  let event: HookEvent;
  try { event = JSON.parse(input) as HookEvent; } catch { return; }
  const dataDir = process.env.AGENT_FOLD_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-fold");
  let port: PortFile;
  try { port = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8")) as PortFile; } catch { return; }
  if (!Number.isInteger(port.port) || typeof port.token !== "string") return;
  if (event.hook_event_name === "Stop" || event.hook_event_name === "UserPromptSubmit" || event.hook_event_name === "SessionEnd") {
    await reportTurn(event, port);
    return;
  }
  try {
    const question = event.tool_name === "AskUserQuestion";
    const resolvingQuestion = question &&
      (event.hook_event_name === "PostToolUse" || event.hook_event_name === "PostToolUseFailure");
    const path = resolvingQuestion
      ? "/v1/providers/claude/question/resolved"
      : question
        ? "/v1/providers/claude/question"
        : "/v1/providers/claude/permission";
    // Label the session in the bar with the title Claude shows in /resume.
    const sessionTitle = resolvingQuestion ? null : await readSessionTitle(event.transcript_path);
    const body = sessionTitle === null ? input : JSON.stringify({ ...event, session_title: sessionTitle });
    const response = await fetch(`http://127.0.0.1:${port.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-agent-fold-token": port.token }, body,
      signal: AbortSignal.timeout(5 * 60 * 1000 + 5_000),
    });
    if (response.ok) process.stdout.write(await response.text());
  } catch {
    // The bridge is optional; preserve Claude Code's native permission prompt.
  }
}

/**
 * Stop, UserPromptSubmit, and SessionEnd are notify-only: they never wait on
 * the user and never write to stdout, because UserPromptSubmit stdout would be
 * injected into Claude's context.
 */
async function reportTurn(event: HookEvent, port: PortFile): Promise<void> {
  // stop_hook_active means another Stop hook already kept Claude going.
  if (event.hook_event_name === "Stop" && event.stop_hook_active === true) return;
  let body: Record<string, unknown> = { hook_event_name: event.hook_event_name, session_id: event.session_id, cwd: event.cwd };
  if (event.hook_event_name === "Stop") {
    const tail = typeof event.last_assistant_message === "string" ? null : await readTranscriptTail(event.transcript_path);
    const message = typeof event.last_assistant_message === "string"
      ? event.last_assistant_message
      : tail === null ? null : lastAssistantText(tail);
    if (message === null) return;
    const sessionTitle = await readSessionTitle(event.transcript_path);
    body = { ...body, last_assistant_message: message, ...(sessionTitle === null ? {} : { session_title: sessionTitle }) };
  }
  const path = event.hook_event_name === "Stop" ? "/v1/providers/claude/stop" : "/v1/providers/claude/resume";
  try {
    await fetch(`http://127.0.0.1:${port.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-agent-fold-token": port.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Notifications are best-effort; never delay Claude's turn.
  }
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

void main();
