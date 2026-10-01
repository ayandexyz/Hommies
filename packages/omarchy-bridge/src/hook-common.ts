/** Plumbing shared by the Claude and Codex command-hook adapters. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConnection { readonly port: number; readonly token: string; }

/** Fields both agents send on Stop, UserPromptSubmit, and SessionEnd. */
export interface TurnHookEvent {
  readonly hook_event_name?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly transcript_path?: string | null;
  readonly stop_hook_active?: boolean;
  readonly last_assistant_message?: string | null;
  /** Sent on UserPromptSubmit. */
  readonly prompt?: string;
}

/** Claude's StopFailure: the turn ended on an API error instead of a reply. */
export interface FailureHookEvent extends TurnHookEvent {
  readonly error?: string;
  readonly error_details?: string;
}

/** Fields both agents send on SessionStart and the tool hooks. */
export interface ActivityHookEvent extends TurnHookEvent {
  readonly tool_name?: string;
  readonly tool_input?: unknown;
}

export function isTurnEvent(name: string | undefined): boolean {
  return name === "Stop" || name === "UserPromptSubmit" || name === "SessionEnd";
}

/**
 * Hooks that only feed the bar's live activity. AskUserQuestion's tool hooks
 * are not activity: they carry the blocking question flow.
 */
export function isActivityEvent(event: ActivityHookEvent): boolean {
  if (event.hook_event_name === "SessionStart") return true;
  return (event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUseFailure") &&
    event.tool_name !== "AskUserQuestion";
}

/** The `tool_input` fields the bridge labels steps with; file contents and diffs stay behind. */
const stepFields = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "description"];

/** The running bridge's port and token, or `null` when it is not running. */
export async function readConnection(): Promise<BridgeConnection | null> {
  const dataDir = process.env.AGENT_FOLD_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-fold");
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8")) as BridgeConnection;
    return Number.isInteger(connection.port) && typeof connection.token === "string" ? connection : null;
  } catch {
    return null;
  }
}

export async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

export function postToBridge(connection: BridgeConnection, path: string, body: string, timeoutMs: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${connection.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-fold-token": connection.token },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export interface TurnSources {
  /** Final assistant text when the hook payload does not carry it. */
  readonly lastAssistantText: (event: TurnHookEvent) => Promise<string | null>;
  readonly sessionTitle: (event: TurnHookEvent) => Promise<string | null>;
}

/**
 * Stop, UserPromptSubmit, and SessionEnd are notify-only: they never wait on
 * the user and never write to stdout, because UserPromptSubmit stdout would be
 * injected into the agent's context.
 */
export async function reportTurn(
  provider: "claude" | "codex",
  event: TurnHookEvent,
  connection: BridgeConnection,
  sources: TurnSources,
): Promise<void> {
  // stop_hook_active means another Stop hook already kept the agent going.
  if (event.hook_event_name === "Stop" && event.stop_hook_active === true) return;
  let body: Record<string, unknown> = { hook_event_name: event.hook_event_name, session_id: event.session_id, cwd: event.cwd };
  if (event.hook_event_name === "UserPromptSubmit" && typeof event.prompt === "string") {
    body = { ...body, prompt: event.prompt.slice(0, 500) };
  }
  if (event.hook_event_name === "Stop") {
    const message = typeof event.last_assistant_message === "string" && event.last_assistant_message.length > 0
      ? event.last_assistant_message
      : await sources.lastAssistantText(event);
    if (message === null) return;
    const sessionTitle = await sources.sessionTitle(event);
    body = { ...body, last_assistant_message: message, ...(sessionTitle === null ? {} : { session_title: sessionTitle }) };
  }
  const path = `/v1/providers/${provider}/${event.hook_event_name === "Stop" ? "stop" : "resume"}`;
  try {
    await postToBridge(connection, path, JSON.stringify(body), 2_000);
  } catch {
    // Notifications are best-effort; never delay the agent's turn.
  }
}

/** Reports a failed turn. Notify-only and never writes to stdout. */
export async function reportFailure(
  provider: "claude" | "codex",
  event: FailureHookEvent,
  connection: BridgeConnection,
  sessionTitle: string | null,
): Promise<void> {
  if (typeof event.error !== "string") return;
  const body = {
    hook_event_name: "StopFailure",
    session_id: event.session_id,
    cwd: event.cwd,
    error: event.error,
    ...(typeof event.error_details === "string" ? { error_details: event.error_details.slice(0, 500) } : {}),
    ...(sessionTitle === null ? {} : { session_title: sessionTitle }),
  };
  try {
    await postToBridge(connection, `/v1/providers/${provider}/failure`, JSON.stringify(body), 2_000);
  } catch {
    // Best-effort, like the other turn hooks.
  }
}

/**
 * SessionStart and tool hooks run on every tool call, so this stays cheap:
 * no transcript reads, a short timeout, and never any stdout (SessionStart
 * stdout would be added to the agent's context; PreToolUse stdout is a decision).
 */
export async function reportActivity(
  provider: "claude" | "codex",
  event: ActivityHookEvent,
  connection: BridgeConnection,
): Promise<void> {
  const input = event.tool_input !== null && typeof event.tool_input === "object" ? event.tool_input as Record<string, unknown> : {};
  const toolInput: Record<string, string> = {};
  for (const field of stepFields) {
    const value = input[field];
    if (typeof value === "string") toolInput[field] = value.slice(0, 300);
  }
  const body = {
    hook_event_name: event.hook_event_name,
    session_id: event.session_id,
    cwd: event.cwd,
    ...(typeof event.tool_name === "string" ? { tool_name: event.tool_name, tool_input: toolInput } : {}),
  };
  try {
    await postToBridge(connection, `/v1/providers/${provider}/activity`, JSON.stringify(body), 1_000);
  } catch {
    // Activity is best-effort; never delay the agent.
  }
}
