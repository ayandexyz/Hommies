/** Plumbing shared by the Claude and Codex command-hook adapters. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { connectToOwnBridge, nonceHeader, proofHeader, validProof } from "./bridge-identity.js";
import { editStats } from "./edit-stats.js";
import { processFields, type ProcessFields } from "./process-tree.js";

export interface BridgeConnection {
  readonly port: number;
  readonly token: string;
  /** Verifies the bridge's responses; never sent. */
  readonly serverKey: string;
}

/** A bridge response whose proof checked out. */
export interface BridgeReply {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

/** Hook replies are a decision or an answer; anything bigger is not from the bridge. */
const maxReplyBytes = 1024 * 1024;

/** The agent (this hook's parent) and its ancestors, so the bar can focus its terminal. */
export const agentProcess = (): Promise<ProcessFields> => processFields(process.ppid);

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
  /** Sent on SubagentStart and SubagentStop. */
  readonly agent_id?: string;
  readonly agent_type?: string;
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
  // Observational: they never block, so they must not reach the permission path.
  if (event.hook_event_name === "SubagentStart" || event.hook_event_name === "SubagentStop") return true;
  if (event.hook_event_name === "StopCancelled") return true;
  return (event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUseFailure") &&
    event.tool_name !== "AskUserQuestion";
}

/** The `tool_input` fields the bridge labels steps with; file contents and diffs stay behind. */
const stepFields = ["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "description"];

const dataHome = (): string => process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");

/**
 * Where the bridge keeps `port.json`. `AGENT_FOLD_DATA_DIR` and the
 * `agent-fold` folder are the names from before the rename to Hommies.
 */
export function bridgeDataDirs(): string[] {
  const override = process.env.HOMMIES_DATA_DIR || process.env.AGENT_FOLD_DATA_DIR;
  return override ? [override] : [join(dataHome(), "hommies"), join(dataHome(), "agent-fold")];
}

/**
 * The running bridge's port, token, and server key, or `null` when it is not
 * running. A `port.json` without a server key (a bridge older than 0.1.6) is
 * treated as no bridge: its responses could not be verified.
 */
export async function readConnection(): Promise<BridgeConnection | null> {
  for (const dataDir of bridgeDataDirs()) {
    try {
      const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8")) as BridgeConnection;
      if (Number.isInteger(connection.port) && connection.port > 0 && connection.port < 65536 &&
        typeof connection.token === "string" && typeof connection.serverKey === "string" && connection.serverKey.length > 0) {
        return connection;
      }
    } catch {
      // Not running from this folder; try the next one.
    }
  }
  return null;
}

/** The token under both header names, so a bridge from before the rename still accepts it. */
export const tokenHeaders = (token: string): Record<string, string> => ({ "x-hommies-token": token, "x-agent-fold-token": token });

export async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

/**
 * POSTs to the bridge, failing closed: the token and body are only written
 * once the port is known to be held by this user, and the reply is only
 * returned if it carries a valid proof for this request's nonce. Otherwise it
 * rejects, and callers keep the agent's own prompt (see bridge-identity.ts).
 */
export async function postToBridge(connection: BridgeConnection, path: string, body: string, timeoutMs: number): Promise<BridgeReply> {
  const nonce = randomBytes(24).toString("base64url");
  const socket = await connectToOwnBridge(connection.port);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: connection.port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        [nonceHeader]: nonce,
        ...tokenHeaders(connection.token),
      },
      // The verified socket, not a pooled or fresh one.
      createConnection: () => socket,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > maxReplyBytes) request.destroy(new Error("bridge reply too large"));
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (!validProof(connection.serverKey, nonce, status, text, response.headers[proofHeader])) {
          reject(new Error("bridge reply could not be verified"));
          return;
        }
        resolve({ ok: status >= 200 && status < 300, status, text });
      });
      response.on("error", reject);
    });
    const timer = setTimeout(() => request.destroy(new Error("bridge request timed out")), timeoutMs);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
    request.end(body);
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
/** `/v1/providers/<provider>` for built-in agents, `/v1/agents/<name>` for custom ones. */
export type BridgeRoute = string;

export async function reportTurn(
  route: BridgeRoute,
  event: TurnHookEvent,
  connection: BridgeConnection,
  sources: TurnSources,
): Promise<void> {
  // stop_hook_active means another Stop hook already kept the agent going.
  if (event.hook_event_name === "Stop" && event.stop_hook_active === true) return;
  let body: Record<string, unknown> = {
    hook_event_name: event.hook_event_name, session_id: event.session_id, cwd: event.cwd, ...await agentProcess(),
  };
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
  const path = `${route}/${event.hook_event_name === "Stop" ? "stop" : "resume"}`;
  try {
    await postToBridge(connection, path, JSON.stringify(body), 2_000);
  } catch {
    // Notifications are best-effort; never delay the agent's turn.
  }
}

/** Reports a failed turn. Notify-only and never writes to stdout. */
export async function reportFailure(
  route: BridgeRoute,
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
    ...await agentProcess(),
  };
  try {
    await postToBridge(connection, `${route}/failure`, JSON.stringify(body), 2_000);
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
  route: BridgeRoute,
  event: ActivityHookEvent,
  connection: BridgeConnection,
): Promise<void> {
  const input = event.tool_input !== null && typeof event.tool_input === "object" ? event.tool_input as Record<string, unknown> : {};
  const toolInput: Record<string, string> = {};
  for (const field of stepFields) {
    const value = input[field];
    if (typeof value === "string") toolInput[field] = value.slice(0, 300);
  }
  // Only the line counts are sent; the edited text stays in this process.
  const edit = event.hook_event_name === "PreToolUse" && typeof event.tool_name === "string"
    ? await editStats(event.tool_name, event.tool_input, event.cwd).catch(() => null)
    : null;
  const body = {
    hook_event_name: event.hook_event_name,
    session_id: event.session_id,
    cwd: event.cwd,
    ...(typeof event.tool_name === "string" ? { tool_name: event.tool_name, tool_input: toolInput } : {}),
    ...(edit === null ? {} : { edit }),
    ...(typeof event.agent_id === "string" ? { agent_id: event.agent_id.slice(0, 200) } : {}),
    ...(typeof event.agent_type === "string" ? { agent_type: event.agent_type.slice(0, 100) } : {}),
    ...await agentProcess(),
  };
  try {
    await postToBridge(connection, `${route}/activity`, JSON.stringify(body), 1_000);
  } catch {
    // Activity is best-effort; never delay the agent.
  }
}
