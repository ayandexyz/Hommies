/**
 * Shared code for the Gemini CLI, Antigravity, and Grok Build hooks. Each
 * agent names its events and fields differently; `translate*` maps a payload
 * onto the Claude-style event the rest of the bridge understands, and
 * `runForeignHook` reports it. These agents get live activity and turn ends
 * only: permission prompts stay in the agent's own UI, so the hooks never
 * return a decision.
 */
import {
  isActivityEvent, isTurnEvent, readConnection, readStdin, reportActivity, reportFailure, reportTurn,
  type ActivityHookEvent, type FailureHookEvent,
} from "./hook-common.js";

export type ForeignProvider = "gemini" | "antigravity" | "grok";

/** The Claude-style event a foreign payload maps to. */
export type TranslatedEvent = ActivityHookEvent & FailureHookEvent;

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/** Our step field for each argument name the agents use, compared without case, `_`, or `-`. */
const argumentAliases: Readonly<Record<string, string>> = {
  command: "command", commandline: "command", cmd: "command",
  filepath: "file_path", targetfile: "file_path", absolutepath: "file_path", file: "file_path",
  notebookpath: "notebook_path",
  path: "path", directorypath: "path", dirpath: "path",
  pattern: "pattern", searchpattern: "pattern", glob: "pattern",
  query: "query", searchquery: "query",
  url: "url",
  description: "description",
  // Kept for edit line counts.
  oldstring: "old_string", newstring: "new_string", content: "content", replaceall: "replace_all", edits: "edits",
};

/** Renames tool arguments to the snake_case fields the bridge labels steps with. */
export function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const alias = argumentAliases[key.toLowerCase().replace(/[_-]/g, "")];
    if (alias !== undefined && !(alias in out)) out[alias] = value;
  }
  return out;
}

/**
 * Gemini CLI sends snake_case fields like Claude, under its own event names:
 * `BeforeTool`, `BeforeAgent` (prompt sent), `AfterAgent` (turn ended, with
 * `prompt_response`). `AfterTool` and the model events are not used.
 */
export function translateGemini(payload: unknown): TranslatedEvent | null {
  if (!isObject(payload)) return null;
  const base = { session_id: str(payload.session_id), cwd: str(payload.cwd) };
  switch (payload.hook_event_name) {
    case "SessionStart":
    case "SessionEnd":
      return { ...base, hook_event_name: payload.hook_event_name };
    case "BeforeTool":
      return { ...base, hook_event_name: "PreToolUse", tool_name: str(payload.tool_name) ?? "Tool", tool_input: normalizeToolInput(payload.tool_input) };
    case "BeforeAgent":
      return { ...base, hook_event_name: "UserPromptSubmit", ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}) };
    case "AfterAgent":
      return {
        ...base,
        hook_event_name: "Stop",
        stop_hook_active: payload.stop_hook_active === true,
        ...(typeof payload.prompt_response === "string" ? { last_assistant_message: payload.prompt_response } : {}),
      };
    default:
      return null;
  }
}

/**
 * Grok Build uses Claude's event names with camelCase fields
 * (`hookEventName`, `sessionId`, `toolName`, ...), and also sets
 * `GROK_HOOK_EVENT` and `GROK_SESSION_ID`. snake_case fields are accepted too.
 */
export function translateGrok(payload: unknown, env: Readonly<Record<string, string | undefined>>): TranslatedEvent | null {
  if (!isObject(payload)) return null;
  const pick = (camel: string, snake: string): unknown => payload[camel] ?? payload[snake];
  const event = str(pick("hookEventName", "hook_event_name")) ?? str(env.GROK_HOOK_EVENT);
  const base = {
    session_id: str(pick("sessionId", "session_id")) ?? str(env.GROK_SESSION_ID),
    cwd: str(payload.cwd) ?? str(pick("workspaceRoot", "workspace_root")) ?? str(env.GROK_WORKSPACE_ROOT),
  };
  switch (event) {
    case "SessionStart":
    case "SessionEnd":
      return { ...base, hook_event_name: event };
    case "PreToolUse":
    case "PostToolUseFailure":
      return { ...base, hook_event_name: event, tool_name: str(pick("toolName", "tool_name")) ?? "Tool", tool_input: normalizeToolInput(pick("toolInput", "tool_input")) };
    case "UserPromptSubmit": {
      const prompt = pick("prompt", "prompt");
      return { ...base, hook_event_name: event, ...(typeof prompt === "string" ? { prompt } : {}) };
    }
    case "Stop": {
      const message = str(pick("lastAssistantMessage", "last_assistant_message"));
      return {
        ...base,
        hook_event_name: event,
        stop_hook_active: pick("stopHookActive", "stop_hook_active") === true,
        ...(message === undefined ? {} : { last_assistant_message: message }),
      };
    }
    case "StopFailure": {
      const error = str(pick("error", "error"));
      const details = str(pick("errorDetails", "error_details"));
      return { ...base, hook_event_name: event, error: error ?? "unknown", ...(details === undefined ? {} : { error_details: details }) };
    }
    default:
      return null;
  }
}

/**
 * Antigravity does not name the event in its payload, so setup passes it as
 * the hook's first argument. Only `PostToolUse` and `Stop` are hooked:
 * `PreToolUse` must answer with a permission decision, and the invocation
 * events fire on every model call rather than once per prompt.
 */
export function translateAntigravity(payload: unknown, event: string | undefined): TranslatedEvent | null {
  if (!isObject(payload)) return null;
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const base = { session_id: str(payload.conversationId), cwd: str(workspaces[0]) };
  const error = str(payload.error);
  if (event === "PostToolUse") {
    const call = isObject(payload.toolCall) ? payload.toolCall : {};
    return {
      ...base,
      // A finished tool call is reported as a step; a failed one as `(failed)`.
      hook_event_name: error === undefined ? "PreToolUse" : "PostToolUseFailure",
      tool_name: str(call.name) ?? "Tool",
      tool_input: normalizeToolInput(call.args),
    };
  }
  if (event === "Stop") {
    if (error !== undefined) return { ...base, hook_event_name: "StopFailure", error: "agent_error", error_details: error };
    // Antigravity runs other work after a non-idle stop; only a fully idle one ends the turn.
    if (payload.fullyIdle === false) return null;
    return { ...base, hook_event_name: "Stop" };
  }
  return null;
}

export interface ForeignHookOptions {
  readonly provider: ForeignProvider;
  readonly translate: (payload: unknown) => TranslatedEvent | null;
  /** Gemini CLI and Antigravity read a JSON object from stdout on every hook. */
  readonly printJson: boolean;
}

/** Reads the agent's payload, reports it, and never blocks or decides anything. */
export async function runForeignHook(options: ForeignHookOptions): Promise<void> {
  try {
    const input = await readStdin();
    let payload: unknown;
    try { payload = JSON.parse(input); } catch { return; }
    const event = options.translate(payload);
    if (event === null || typeof event.session_id !== "string") return;
    const connection = await readConnection();
    if (connection === null) return;
    const route = `/v1/providers/${options.provider}`;
    if (isActivityEvent(event)) return await reportActivity(route, event, connection);
    if (event.hook_event_name === "StopFailure") return await reportFailure(route, event, connection, null);
    if (isTurnEvent(event.hook_event_name)) {
      await reportTurn(route, event, connection, {
        // No transcript format to read: a Stop without its final message is still a finished turn.
        lastAssistantText: async () => "Turn finished.",
        sessionTitle: async () => null,
      });
    }
  } catch {
    // The bridge is optional; the agent carries on as if no hook ran.
  } finally {
    // An empty object is a no-op answer: no decision, no injected steps.
    if (options.printJson) process.stdout.write("{}\n");
  }
}
