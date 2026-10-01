/**
 * OpenCode server plugin: mirrors permission requests, `question` tool calls,
 * turn ends, and tool activity into agent-fold, and answers OpenCode with what
 * you pick in the bar.
 *
 * OpenCode has no command hooks, so this runs inside OpenCode and talks to it
 * through the plugin's in-process client. Requests stay open in OpenCode's TUI
 * too; whichever surface answers first wins, and the other one is cleared.
 * Subagent sessions are reported under their root session so the bar shows
 * one row per conversation.
 *
 * Only the plugin function is exported: OpenCode calls every export of a
 * plugin module as a plugin.
 */
import { postToBridge, readConnection } from "./hook-common.js";
import { processFields, type ProcessFields } from "./process-tree.js";

interface RequestOptions {
  readonly url: string;
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The hey-api client behind `input.client`; it reaches OpenCode's server in-process. */
interface OpenCodeHttp {
  get(options: RequestOptions): Promise<{ readonly data?: unknown }>;
  post(options: RequestOptions): Promise<{ readonly data?: unknown }>;
}

interface PluginInput {
  readonly client: { readonly _client?: OpenCodeHttp };
}

interface OpenCodeEvent {
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

interface SessionInfo {
  readonly id: string;
  readonly directory?: string;
  readonly title?: string;
  readonly parentID?: string;
}

const hookTimeoutMs = 5 * 60 * 1000 + 5_000;
const turnTimeoutMs = 2_000;
/** OpenCode names sessions like this until it has generated a title. */
const placeholderTitle = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

export const AgentFoldOpenCode = async (input: PluginInput) => {
  const http = input.client._client;
  /** Child session id → root session id. Parents never change. */
  const roots = new Map<string, string>();
  /** Requests already forwarded, in case OpenCode delivers an event twice. */
  const forwarded = new Set<string>();
  /** Sessions the user interrupted; their next idle is not a finished turn. */
  const aborted = new Set<string>();
  /** Sessions whose turn failed; their next idle is already reported as the failure. */
  const failed = new Set<string>();
  /** This plugin runs inside OpenCode, so OpenCode's own ancestry leads to its terminal. */
  let ownProcess: Promise<ProcessFields> | null = null;

  const getSession = async (id: string): Promise<SessionInfo | null> => {
    if (!http) return null;
    try {
      const { data } = await http.get({ url: "/session/{sessionID}", path: { sessionID: id } });
      return isSession(data) ? data : null;
    } catch {
      return null;
    }
  };

  const rootSession = async (id: string): Promise<SessionInfo | null> => {
    let session = await getSession(roots.get(id) ?? id);
    for (let depth = 0; session?.parentID && depth < 8; depth++) session = await getSession(session.parentID);
    if (session) roots.set(id, session.id);
    return session;
  };

  /** Fields every bridge request about a session carries. */
  const sessionFields = (session: SessionInfo): Record<string, string> => ({
    session_id: session.id,
    ...(session.directory ? { cwd: session.directory } : {}),
    ...(session.title && !placeholderTitle.test(session.title) ? { session_title: session.title } : {}),
  });

  const send = async (path: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    const connection = await readConnection();
    if (connection === null) return null;
    ownProcess ??= processFields(process.pid);
    const withProcess = body !== null && typeof body === "object" ? { ...body, ...await ownProcess } : body;
    const response = await postToBridge(connection, path, JSON.stringify(withProcess), timeoutMs);
    return response.ok ? await response.json() as unknown : null;
  };

  const resume = (sessionId: string, event: "UserPromptSubmit" | "SessionEnd"): Promise<unknown> =>
    send("/v1/providers/opencode/resume", { hook_event_name: event, session_id: roots.get(sessionId) ?? sessionId }, turnTimeoutMs);

  const onPermission = async (request: Readonly<Record<string, unknown>>): Promise<void> => {
    const id = request.id;
    const sessionId = request.sessionID;
    if (!http || typeof id !== "string" || typeof sessionId !== "string" || forwarded.has(id)) return;
    const session = await rootSession(sessionId);
    if (!session) return;
    forwarded.add(id);
    try {
      const result = await send("/v1/providers/opencode/permission", {
        ...sessionFields(session),
        hook_event_name: "PermissionRequest",
        request_id: id,
        tool_name: typeof request.permission === "string" ? request.permission : "permission",
        tool_input: permissionDetail(request),
      }, hookTimeoutMs);
      const behavior = decisionOf(result);
      // No decision (cancel, timeout, answered in the TUI): OpenCode keeps its prompt.
      if (behavior === null) return;
      await http.post({
        url: "/permission/{requestID}/reply",
        path: { requestID: id },
        body: { reply: behavior === "always" ? "always" : behavior === "allow" ? "once" : "reject" },
        headers: { "content-type": "application/json" },
      });
    } finally {
      forwarded.delete(id);
    }
  };

  const onQuestion = async (request: Readonly<Record<string, unknown>>): Promise<void> => {
    const id = request.id;
    const sessionId = request.sessionID;
    if (!http || typeof id !== "string" || typeof sessionId !== "string" || !Array.isArray(request.questions) || forwarded.has(id)) return;
    const session = await rootSession(sessionId);
    if (!session) return;
    forwarded.add(id);
    try {
      const result = await send("/v1/providers/opencode/question", {
        ...sessionFields(session), request_id: id, questions: request.questions,
      }, hookTimeoutMs);
      const answers = answersOf(result);
      if (answers === null) return;
      await http.post({
        url: "/question/{requestID}/reply",
        path: { requestID: id },
        body: { answers },
        headers: { "content-type": "application/json" },
      });
    } finally {
      forwarded.delete(id);
    }
  };

  /** A request was answered (in the TUI or by us): drop it from the bar. */
  const onResolved = async (kind: "permission" | "question", reply: Readonly<Record<string, unknown>>): Promise<void> => {
    if (typeof reply.requestID !== "string" || typeof reply.sessionID !== "string") return;
    await send(`/v1/providers/opencode/${kind}/resolved`, {
      session_id: roots.get(reply.sessionID) ?? reply.sessionID, request_id: reply.requestID,
    }, turnTimeoutMs);
  };

  /** Reports a tool call as live activity. Fire-and-forget, like the command hooks. */
  const onToolCall = async (sessionId: string, tool: string, args: unknown): Promise<void> => {
    const rootId = roots.get(sessionId);
    const session = rootId === undefined ? await rootSession(sessionId) : null;
    const fields = session === null ? { session_id: rootId ?? sessionId } : sessionFields(session);
    await send("/v1/providers/opencode/activity", {
      ...fields, hook_event_name: "PreToolUse", tool_name: tool, tool_input: stepDetail(args),
    }, turnTimeoutMs);
  };

  const onFailure = async (sessionId: string, error: Readonly<Record<string, unknown>>): Promise<void> => {
    const session = await getSession(sessionId);
    // A subagent failing is reported by the conversation that started it.
    if (!session || session.parentID) return;
    failed.add(sessionId);
    const data = isRecord(error.data) ? error.data : {};
    await send("/v1/providers/opencode/failure", {
      ...sessionFields(session),
      hook_event_name: "StopFailure",
      error: failureName(error, data),
      ...(typeof data.message === "string" ? { error_details: data.message.slice(0, 500) } : {}),
    }, turnTimeoutMs);
  };

  const onIdle = async (sessionId: string): Promise<void> => {
    const session = await getSession(sessionId);
    // Subagents finishing is not the conversation finishing.
    if (!session || session.parentID) return;
    if (aborted.delete(sessionId)) {
      await resume(sessionId, "UserPromptSubmit");
      return;
    }
    if (failed.delete(sessionId)) return;
    const message = await lastAssistantText(sessionId);
    if (message === null) return;
    await send("/v1/providers/opencode/stop", {
      ...sessionFields(session), hook_event_name: "Stop", last_assistant_message: message,
    }, turnTimeoutMs);
  };

  const lastAssistantText = async (sessionId: string): Promise<string | null> => {
    if (!http) return null;
    try {
      const { data } = await http.get({ url: "/session/{sessionID}/message", path: { sessionID: sessionId }, query: { limit: 1 } });
      return Array.isArray(data) ? finalText(data.at(-1)) : null;
    } catch {
      return null;
    }
  };

  const handle = async (event: OpenCodeEvent): Promise<void> => {
    const properties = event.properties;
    const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : null;
    switch (event.type) {
      case "permission.asked": return onPermission(properties);
      case "permission.replied": return onResolved("permission", properties);
      case "question.asked": return onQuestion(properties);
      case "question.replied":
      case "question.rejected": return onResolved("question", properties);
      case "session.idle": return sessionId === null ? undefined : onIdle(sessionId);
      case "session.error": {
        const error = properties.error;
        if (sessionId === null || !isRecord(error)) return;
        if (error.name === "MessageAbortedError") aborted.add(sessionId);
        else return onFailure(sessionId, error);
        return;
      }
      case "session.deleted":
        if (sessionId === null) return;
        await resume(sessionId, "SessionEnd");
        roots.delete(sessionId);
        return;
      default: return;
    }
  };

  return {
    // Never await here: a pending permission would stall OpenCode's other events.
    event: async ({ event }: { readonly event: OpenCodeEvent }): Promise<void> => {
      void handle(event).catch(() => {
        // The bridge is optional; OpenCode keeps its own prompts.
      });
    },
    "chat.message": async ({ sessionID }: { readonly sessionID: string }): Promise<void> => {
      aborted.delete(sessionID);
      failed.delete(sessionID);
      void resume(sessionID, "UserPromptSubmit").catch(() => undefined);
    },
    "tool.execute.before": async (
      { tool, sessionID }: { readonly tool: string; readonly sessionID: string },
      output: { readonly args?: unknown },
    ): Promise<void> => {
      // The question tool already shows up as a question item.
      if (tool === "question") return;
      void onToolCall(sessionID, tool, output?.args).catch(() => undefined);
    },
  };
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}

function isSession(value: unknown): value is SessionInfo {
  return isRecord(value) && typeof value.id === "string";
}

/** The fields `describeTool` in the bridge reads, without large diffs. */
function permissionDetail(request: Readonly<Record<string, unknown>>): Record<string, string> {
  const metadata = isRecord(request.metadata) ? request.metadata : {};
  const patterns = Array.isArray(request.patterns) ? request.patterns.filter((pattern) => typeof pattern === "string") : [];
  const filePath = typeof metadata.filepath === "string" ? metadata.filepath : typeof metadata.filePath === "string" ? metadata.filePath : null;
  return {
    ...(typeof metadata.command === "string" ? { command: metadata.command } : {}),
    ...(filePath === null ? {} : { file_path: filePath }),
    ...(patterns.length > 0 ? { description: patterns.join(" ") } : {}),
  };
}

/** OpenCode tool args use camelCase; the bridge labels steps from these snake_case fields. */
function stepDetail(args: unknown): Record<string, string> {
  if (!isRecord(args)) return {};
  const fields: Record<string, unknown> = {
    command: args.command,
    file_path: args.filePath ?? args.file_path,
    path: args.path,
    pattern: args.pattern,
    query: args.query,
    url: args.url,
    description: args.description,
  };
  const detail: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) if (typeof value === "string") detail[key] = value.slice(0, 300);
  return detail;
}

/** Maps an OpenCode session error to the bridge's (Claude's) failure names. */
function failureName(error: Readonly<Record<string, unknown>>, data: Readonly<Record<string, unknown>>): string {
  if (error.name === "ProviderAuthError") return "authentication_failed";
  if (error.name === "MessageOutputLengthError") return "max_output_tokens";
  if (error.name === "APIError") {
    if (data.statusCode === 429) return "rate_limit";
    if (data.statusCode === 529) return "overloaded";
    if (typeof data.statusCode === "number" && data.statusCode >= 500) return "server_error";
  }
  return "unknown";
}

function decisionOf(result: unknown): "allow" | "always" | "deny" | null {
  if (!isRecord(result) || !isRecord(result.hookSpecificOutput)) return null;
  const decision = result.hookSpecificOutput.decision;
  if (!isRecord(decision)) return null;
  if (decision.behavior === "allow") return decision.remember === true ? "always" : "allow";
  return decision.behavior === "deny" ? "deny" : null;
}

function answersOf(result: unknown): string[][] | null {
  if (!isRecord(result) || !Array.isArray(result.answers)) return null;
  const answers = result.answers.filter((answer): answer is string[] =>
    Array.isArray(answer) && answer.every((label) => typeof label === "string"));
  return answers.length === result.answers.length ? answers : null;
}

/** Text of the final assistant message; `null` when the turn ended without any. */
function finalText(message: unknown): string | null {
  if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant" || !Array.isArray(message.parts)) return null;
  const text = message.parts
    .filter((part): part is Readonly<Record<string, unknown>> =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true)
    .map((part) => String(part.text))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}
