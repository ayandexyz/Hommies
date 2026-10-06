/**
 * OpenCode V2 server plugin: the V2 port of `opencode-plugin.ts`. It mirrors
 * permission requests, `question` tool forms, turn ends, and tool activity
 * into Hommies, and answers OpenCode with what you pick in the bar.
 *
 * V2 loads plugins from a directory listed under `plugins` in
 * `opencode.json` and wants `export default { id, setup }`; V1 plugin
 * functions do not run there. OpenCode resolves this directory to
 * `server.js`.
 *
 * Differences from V1 that this port absorbs:
 * - Events are `{ type, data }` from `ctx.event.subscribe`, not `{ type, properties }`.
 * - The `question` tool asks through a form (`form.created`, fields `q0..qN`)
 *   instead of `question.asked`. Plugins have no form API, so form answers go
 *   to the local OpenCode service's HTTP API (`$XDG_STATE_HOME/opencode/service.json`).
 * - A turn ends with exactly one of `session.execution.succeeded`, `.failed`, or
 *   `.interrupted`. OpenCode 2.0.24 never emits `session.idle`, and nothing
 *   follows those three, so each is final (`session.error` is gone too).
 * - Plugins run in the shared OpenCode service, not under the terminal, so no
 *   process ancestry is sent: it would lead to the wrong window.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { editStats } from "../edit-stats.js";
import {
  answersOf, decisionOf, hookTimeoutMs, isRecord, placeholderTitle, sendToBridge, stepDetail, turnTimeoutMs,
} from "../opencode-common.js";

/** The parts of OpenCode's V2 plugin context (`@opencode/plugin`) this plugin uses. */
interface Registration {
  readonly dispose: () => Promise<void>;
}

interface V2Event {
  readonly type: string;
  readonly data?: unknown;
}

interface ToolExecuteBefore {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
}

interface SessionPrompt {
  readonly sessionID: string;
  readonly prompt?: { readonly text?: unknown };
}

export interface PluginContext {
  readonly event: {
    readonly subscribe: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<V2Event>;
  };
  readonly session: {
    readonly get: (input: { readonly sessionID: string }) => Promise<unknown>;
    readonly context: (input: { readonly sessionID: string }) => Promise<unknown>;
    readonly hook: (name: "prompt", callback: (input: SessionPrompt) => void | Promise<void>) => Promise<Registration>;
  };
  readonly permission: {
    readonly reply: (input: {
      readonly sessionID: string;
      readonly requestID: string;
      readonly decision: "once" | "always" | "reject";
    }) => Promise<unknown>;
  };
  readonly tool: {
    readonly hook: (name: "execute.before", callback: (input: ToolExecuteBefore) => void | Promise<void>) => Promise<Registration>;
  };
}

interface SessionInfo {
  readonly id: string;
  readonly directory?: string;
  readonly title?: string;
  readonly parentID?: string;
}

/** A `question` field as the V2 question tool builds it. */
interface QuestionField {
  readonly key: string;
  readonly multiple: boolean;
  readonly prompt: { question: string; header: string; multiple: boolean; options: { label: string; description: string }[] };
}

/** Where the local OpenCode service answers, from its registration file. */
interface ServiceEndpoint {
  readonly url: string;
  readonly password?: string;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export async function setup(ctx: PluginContext): Promise<() => Promise<void>> {
  /** Child session id → root session id. Parents never change. */
  const roots = new Map<string, string>();
  /** Requests already forwarded, in case OpenCode delivers an event twice. */
  const forwarded = new Set<string>();
  /** Sessions whose current turn's end is already reported; cleared when the next turn starts. */
  const ended = new Set<string>();

  const getSession = async (id: string): Promise<SessionInfo | null> => {
    try {
      return sessionInfo(await ctx.session.get({ sessionID: id }));
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

  const resume = (sessionId: string, event: "UserPromptSubmit" | "SessionEnd"): Promise<unknown> =>
    sendToBridge("/v1/providers/opencode/resume", { hook_event_name: event, session_id: roots.get(sessionId) ?? sessionId }, turnTimeoutMs);

  /** A new prompt: the session is thinking again. Named and placed, so a new session's row is complete. */
  const onPrompt = async (sessionId: string, text: unknown): Promise<void> => {
    const session = await getSession(sessionId);
    // Subagent prompts belong to the conversation's turn, whose end is reported for the root.
    if (!session || session.parentID) return;
    roots.set(sessionId, session.id);
    await sendToBridge("/v1/providers/opencode/resume", {
      ...sessionFields(session),
      hook_event_name: "UserPromptSubmit",
      ...(typeof text === "string" && text.trim().length > 0 ? { prompt: text } : {}),
    }, turnTimeoutMs);
  };

  const onPermission = async (request: Readonly<Record<string, unknown>>): Promise<void> => {
    const id = request.id;
    const sessionId = request.sessionID;
    if (typeof id !== "string" || typeof sessionId !== "string" || forwarded.has(id)) return;
    const session = await rootSession(sessionId);
    if (!session) return;
    forwarded.add(id);
    try {
      const result = await sendToBridge("/v1/providers/opencode/permission", {
        ...sessionFields(session),
        hook_event_name: "PermissionRequest",
        request_id: id,
        tool_name: typeof request.action === "string" ? request.action : "permission",
        tool_input: permissionDetail(request),
      }, hookTimeoutMs);
      const behavior = decisionOf(result);
      // No decision (cancel, timeout, answered in the TUI): OpenCode keeps its prompt.
      if (behavior === null) return;
      await ctx.permission.reply({
        sessionID: sessionId,
        requestID: id,
        decision: behavior === "always" ? "always" : behavior === "allow" ? "once" : "reject",
      });
    } finally {
      forwarded.delete(id);
    }
  };

  const onForm = async (form: unknown): Promise<void> => {
    if (!isRecord(form) || typeof form.id !== "string" || typeof form.sessionID !== "string" || forwarded.has(form.id)) return;
    const fields = questionFields(form);
    // Other forms (sign-ins, plugin forms) stay in OpenCode.
    if (fields === null) return;
    const { id, sessionID: sessionId } = form;
    const session = await rootSession(sessionId);
    if (!session) return;
    forwarded.add(id);
    try {
      const result = await sendToBridge("/v1/providers/opencode/question", {
        ...sessionFields(session), request_id: id, questions: fields.map((field) => field.prompt),
      }, hookTimeoutMs);
      const answers = answersOf(result);
      if (answers === null) return;
      await replyToForm(sessionId, id, formAnswer(fields, answers));
    } finally {
      forwarded.delete(id);
    }
  };

  /** A request was answered (in the TUI or by us): drop it from the bar. */
  const onResolved = async (kind: "permission" | "question", sessionId: unknown, requestId: unknown): Promise<void> => {
    if (typeof requestId !== "string" || typeof sessionId !== "string") return;
    await sendToBridge(`/v1/providers/opencode/${kind}/resolved`, {
      session_id: roots.get(sessionId) ?? sessionId, request_id: requestId,
    }, turnTimeoutMs);
  };

  /** Reports a tool call as live activity. Fire-and-forget, like the command hooks. */
  const onToolCall = async (sessionId: string, tool: string, args: unknown): Promise<void> => {
    const rootId = roots.get(sessionId);
    const session = rootId === undefined ? await rootSession(sessionId) : null;
    const fields: Record<string, string> = session === null ? { session_id: rootId ?? sessionId } : sessionFields(session);
    // Only the line counts are sent; the edited text stays in OpenCode.
    const edit = await editStats(tool, args, fields.cwd).catch(() => null);
    await sendToBridge("/v1/providers/opencode/activity", {
      ...fields, hook_event_name: "PreToolUse", tool_name: tool, tool_input: stepDetail(args), ...(edit === null ? {} : { edit }),
    }, turnTimeoutMs);
  };

  /** Claims a turn's end so it is reported once, whichever end event arrives first. */
  const claimEnd = (sessionId: string): boolean => {
    if (ended.has(sessionId)) return false;
    ended.add(sessionId);
    return true;
  };

  const onFailure = async (sessionId: string, error: unknown): Promise<void> => {
    if (!claimEnd(sessionId)) return;
    const session = await getSession(sessionId);
    // A subagent failing is reported by the conversation that started it.
    if (!session || session.parentID) return;
    const details = isRecord(error) && typeof error.message === "string" ? error.message : null;
    await sendToBridge("/v1/providers/opencode/failure", {
      ...sessionFields(session),
      hook_event_name: "StopFailure",
      error: failureName(error),
      ...(details === null ? {} : { error_details: details.slice(0, 500) }),
    }, turnTimeoutMs);
  };

  /** Esc: the interrupted turn is neither a question nor a finished report. */
  const onInterrupted = async (sessionId: string): Promise<void> => {
    if (!claimEnd(sessionId)) return;
    const session = await getSession(sessionId);
    if (!session || session.parentID) return;
    await resume(sessionId, "UserPromptSubmit");
  };

  const onSucceeded = async (sessionId: string): Promise<void> => {
    if (!claimEnd(sessionId)) return;
    const session = await getSession(sessionId);
    // Subagents finishing is not the conversation finishing.
    if (!session || session.parentID) return;
    const message = await lastAssistantText(sessionId);
    if (message === null) return;
    await sendToBridge("/v1/providers/opencode/stop", {
      ...sessionFields(session), hook_event_name: "Stop", last_assistant_message: message,
    }, turnTimeoutMs);
  };

  const lastAssistantText = async (sessionId: string): Promise<string | null> => {
    try {
      return finalText(await ctx.session.context({ sessionID: sessionId }));
    } catch {
      return null;
    }
  };

  const handle = async (event: V2Event): Promise<void> => {
    const data = isRecord(event.data) ? event.data : {};
    const sessionId = typeof data.sessionID === "string" ? data.sessionID : null;
    switch (event.type) {
      case "permission.asked": return onPermission(data);
      case "permission.replied": return onResolved("permission", data.sessionID, data.requestID);
      case "form.created": return onForm(data.form);
      case "form.replied":
      case "form.cancelled": return onResolved("question", data.sessionID, data.id);
      case "session.execution.started":
        if (sessionId !== null) ended.delete(sessionId);
        return;
      // `session.idle` is not emitted by OpenCode 2.0.24; if a later version sends it
      // after `succeeded`, `claimEnd` drops the duplicate.
      case "session.execution.succeeded":
      case "session.idle": return sessionId === null ? undefined : onSucceeded(sessionId);
      case "session.execution.interrupted": return sessionId === null ? undefined : onInterrupted(sessionId);
      case "session.execution.failed": return sessionId === null ? undefined : onFailure(sessionId, data.error);
      case "session.deleted":
        if (sessionId === null) return;
        await resume(sessionId, "SessionEnd");
        roots.delete(sessionId);
        ended.delete(sessionId);
        return;
      default: return;
    }
  };

  const stop = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
      // Never await here: a pending permission would stall OpenCode's other events.
      void handle(event).catch(() => {
        // The bridge is optional; OpenCode keeps its own prompts.
      });
    }
  })().catch(() => undefined);

  const registrations = await Promise.all([
    ctx.session.hook("prompt", ({ sessionID, prompt }) => {
      ended.delete(sessionID);
      void onPrompt(sessionID, prompt?.text).catch(() => undefined);
    }),
    ctx.tool.hook("execute.before", ({ tool, sessionID, input }) => {
      // The question tool already shows up as a question item.
      if (tool === "question") return;
      void onToolCall(sessionID, tool, input).catch(() => undefined);
    }),
  ]);

  return async () => {
    stop.abort();
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
}

export default { id: "hommies", setup };

function sessionInfo(value: unknown): SessionInfo | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const directory = isRecord(value.location) && typeof value.location.directory === "string" ? value.location.directory : undefined;
  return {
    id: value.id,
    ...(directory === undefined ? {} : { directory }),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
  };
}

/** The fields `describeTool` in the bridge reads, without large diffs. */
function permissionDetail(request: Readonly<Record<string, unknown>>): Record<string, string> {
  const metadata = isRecord(request.metadata) ? request.metadata : {};
  const resources = Array.isArray(request.resources) ? request.resources.filter((resource) => typeof resource === "string") : [];
  const filePath = typeof metadata.filepath === "string" ? metadata.filepath : typeof metadata.filePath === "string" ? metadata.filePath : null;
  return {
    ...(typeof metadata.command === "string" ? { command: metadata.command } : {}),
    ...(filePath === null ? {} : { file_path: filePath }),
    ...(resources.length > 0 ? { description: resources.join(" ") } : {}),
  };
}

/** The fields of a `question` tool form, in V1 question shape; `null` for any other form. */
function questionFields(form: Readonly<Record<string, unknown>>): QuestionField[] | null {
  if (!isRecord(form.metadata) || form.metadata.kind !== "question" || !Array.isArray(form.fields) || form.fields.length === 0) return null;
  const fields: QuestionField[] = [];
  for (const field of form.fields) {
    if (!isRecord(field) || typeof field.key !== "string" || (field.type !== "string" && field.type !== "multiselect")) return null;
    const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
    const multiple = field.type === "multiselect";
    fields.push({
      key: field.key,
      multiple,
      prompt: {
        question: typeof field.description === "string" ? field.description : typeof field.title === "string" ? field.title : field.key,
        header: typeof field.title === "string" ? field.title : "",
        multiple,
        options: options.map((option) => ({
          label: typeof option.label === "string" ? option.label : String(option.value ?? ""),
          description: typeof option.description === "string" ? option.description : "",
        })),
      },
    });
  }
  return fields;
}

/** One label array per question → the form answer the question tool reads (`q0`, `q1`, …). */
function formAnswer(fields: readonly QuestionField[], answers: readonly string[][]): Record<string, string | string[]> {
  const answer: Record<string, string | string[]> = {};
  fields.forEach((field, index) => {
    const labels = answers[index] ?? [];
    if (labels.length === 0) return;
    answer[field.key] = field.multiple ? [...labels] : labels.join(", ");
  });
  return answer;
}

/** Answers a form through the local OpenCode service's HTTP API. */
async function replyToForm(sessionId: string, formId: string, answer: Record<string, string | string[]>): Promise<void> {
  const service = await serviceEndpoint();
  if (service === null) return;
  const url = new URL(`api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, service.url.endsWith("/") ? service.url : `${service.url}/`);
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(service.password === undefined ? {} : { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` }),
    },
    body: JSON.stringify({ answer }),
    signal: AbortSignal.timeout(turnTimeoutMs),
  });
}

/** The local OpenCode service, or `null` when it is unregistered or not on loopback. */
async function serviceEndpoint(): Promise<ServiceEndpoint | null> {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  try {
    const info: unknown = JSON.parse(await readFile(join(stateHome, "opencode", "service.json"), "utf8"));
    if (!isRecord(info) || typeof info.url !== "string") return null;
    // The service password never leaves the machine.
    if (!loopbackHosts.has(new URL(info.url).hostname)) return null;
    return { url: info.url, ...(typeof info.password === "string" ? { password: info.password } : {}) };
  } catch {
    return null;
  }
}

/** Maps an OpenCode V2 structured session error to the bridge's (Claude's) failure names. */
function failureName(error: unknown): string {
  if (!isRecord(error)) return "unknown";
  const status = error.status;
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (typeof status === "number" && status >= 500) return "server_error";
  if (typeof error.type === "string" && /output.?length|max.?tokens/i.test(error.type)) return "max_output_tokens";
  return "unknown";
}

/** Text of the latest assistant message in a session's context; `null` when the turn ended without any. */
function finalText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index];
    if (!isRecord(message)) continue;
    // The user spoke after the last reply: this turn has no assistant text.
    if (message.type === "user") return null;
    if (message.type !== "assistant") continue;
    if (!Array.isArray(message.content)) return null;
    const text = message.content
      .filter((part): part is Readonly<Record<string, unknown>> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
