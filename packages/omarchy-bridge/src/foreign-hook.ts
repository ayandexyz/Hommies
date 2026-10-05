/**
 * Shared code for the Gemini CLI, Antigravity, and Grok Build hooks. Each
 * agent names its events and fields differently; `translate*` maps a payload
 * onto the Claude-style event the rest of the bridge understands, and
 * `runForeignHook` reports it. Antigravity also exposes blocking PreToolUse
 * decisions, which let Hommies answer its questions and permission requests.
 */
import { appendPrivateFile } from "./safe-file.js";

import {
  agentProcess, isActivityEvent, isTurnEvent, postToBridge, readConnection, readStdin, reportActivity, reportFailure, reportTurn,
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
  // Kept for edit line counts (Antigravity's names map onto Claude's).
  oldstring: "old_string", newstring: "new_string", content: "content", replaceall: "replace_all", edits: "edits",
  targetcontent: "old_string", replacementcontent: "new_string", codecontent: "content", allowmultiple: "replace_all",
  replacementchunks: "edits", overwrite: "overwrite", expectedreplacements: "expected_replacements",
};

/** Renames tool arguments to the snake_case fields the bridge labels steps with. */
export function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const alias = argumentAliases[key.toLowerCase().replace(/[_-]/g, "")];
    if (alias === undefined || alias in out) continue;
    // Each chunk of a multi-replace gets the same renaming.
    out[alias] = alias === "edits" && Array.isArray(value) ? value.map(normalizeToolInput) : value;
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

/** Grok's own snake_case event names (`pre_tool_use`) as Claude's (`PreToolUse`). */
const pascalEvent = (name: string | undefined): string | undefined =>
  name?.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");

/**
 * Grok Build sends every field twice, camelCase and Claude's snake_case. The
 * event name differs between them: `hook_event_name` is Claude's PascalCase
 * (`PreToolUse`), while `hookEventName` and `GROK_HOOK_EVENT` are Grok's own
 * snake_case (`pre_tool_use`). Events from inside a subagent carry
 * `subagentType` and are skipped: they are not the session's own turn.
 */
export function translateGrok(payload: unknown, env: Readonly<Record<string, string | undefined>>): TranslatedEvent | null {
  if (!isObject(payload)) return null;
  if (str(payload.subagentType) !== undefined) return null;
  const pick = (camel: string, snake: string): unknown => payload[snake] ?? payload[camel];
  const event = str(payload.hook_event_name) ?? pascalEvent(str(payload.hookEventName) ?? str(env.GROK_HOOK_EVENT));
  const base = {
    session_id: str(pick("sessionId", "session_id")) ?? str(env.GROK_SESSION_ID),
    cwd: str(payload.cwd) ?? str(pick("workspaceRoot", "workspace_root")) ?? str(env.GROK_WORKSPACE_ROOT),
  };
  switch (event) {
    case "SessionStart":
    case "SessionEnd":
      return { ...base, hook_event_name: event };
    case "PreToolUse":
    case "PostToolUseFailure": {
      const tool = str(pick("toolName", "tool_name")) ?? "Tool";
      // The `question` hook entry reports this one; a step here would clear the question it posts.
      if (tool === "ask_user_question" && event === "PreToolUse") return null;
      return { ...base, hook_event_name: event, tool_name: tool, tool_input: normalizeToolInput(pick("toolInput", "tool_input")) };
    }
    case "UserPromptSubmit": {
      const prompt = pick("prompt", "prompt");
      return { ...base, hook_event_name: event, ...(typeof prompt === "string" ? { prompt } : {}) };
    }
    case "Stop": {
      // A second Stop fires at session end (`reason: "shutdown"`); only `end_turn` ends a turn.
      const reason = str(payload.reason);
      if (reason !== undefined && reason !== "end_turn") return null;
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
    case "StopCancelled":
      // An interrupted or declined turn: no finished item, but the session is no longer busy.
      return { ...base, hook_event_name: event };
    default:
      return null;
  }
}

/**
 * The text of Antigravity's final reply this turn, from its
 * `transcript_full.jsonl`: the last model response without tool calls after
 * the last user message.
 */
export function lastAntigravityText(transcript: string): string | null {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: unknown;
    try { entry = JSON.parse(lines[index] ?? ""); } catch { continue; }
    if (!isObject(entry)) continue;
    if (entry.type === "USER_INPUT") return null;
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
    const content = str(entry.content)?.trim();
    if (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE" && calls.length === 0 && content) return content;
  }
  return null;
}

/**
 * Antigravity's `ask_question` call as a Claude AskUserQuestion hook body, or
 * null for any other tool. Its options are plain strings and its multi-select
 * flag is `is_multi_select`.
 */
export function antigravityQuestion(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload) || !isObject(payload.toolCall) || payload.toolCall.name !== "ask_question") return null;
  const args = isObject(payload.toolCall.args) ? payload.toolCall.args : {};
  const raw = Array.isArray(args.questions) ? args.questions : [];
  const questions = raw.flatMap((question: unknown, index: number) => {
    if (!isObject(question)) return [];
    const options = (Array.isArray(question.options) ? question.options : [])
      .filter((option: unknown): option is string => typeof option === "string" && option.length > 0)
      .map((label: string) => ({ label }));
    return [{
      question: str(question.question) ?? `Question ${index + 1}`,
      header: raw.length > 1 ? `Question ${index + 1}` : "Question",
      options,
      multiSelect: question.is_multi_select === true,
    }];
  });
  const session = str(payload.conversationId);
  if (questions.length === 0 || session === undefined) return null;
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const cwd = str(workspaces[0]);
  return {
    hook_event_name: "PreToolUse",
    session_id: session,
    ...(cwd === undefined ? {} : { cwd }),
    tool_name: "AskUserQuestion",
    tool_use_id: `${session}:${typeof payload.stepIdx === "number" ? payload.stepIdx : Date.now()}`,
    tool_input: { questions },
  };
}

/** Built-ins that are observational or read-only and should keep native policy. */
const antigravityNeutralTools = new Set([
  "view_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "manage_task",
  "schedule",
  "list_permissions",
  "invoke_subagent",
  "define_subagent",
  "send_message",
  "manage_subagents",
  "ask_question",
]);

/** A concise Claude-style label for the permission card. */
function antigravityToolLabel(tool: string): string {
  switch (tool) {
    case "run_command": return "Bash";
    case "write_to_file": return "Write";
    case "replace_file_content":
    case "multi_replace_file_content": return "Edit";
    case "search_web": return "WebSearch";
    case "read_url_content": return "WebFetch";
    case "ask_permission": return "Permission";
    case "generate_image": return "ImageGen";
    default: return tool.startsWith("browser_") ? "Browser" : tool;
  }
}

/** The temporary grant Antigravity accepts with an allow decision, when known. */
function antigravityPermissionResource(tool: string, args: Json): string | null {
  const value = (camel: string, lower: string): string | undefined => str(args[camel]) ?? str(args[lower]);
  if (tool === "run_command") {
    const command = value("CommandLine", "command");
    return command === undefined ? null : `command(${command})`;
  }
  if (tool === "write_to_file" || tool === "replace_file_content" || tool === "multi_replace_file_content") {
    const path = value("TargetFile", "target_file");
    return path === undefined ? null : `write_file(${path})`;
  }
  if (tool === "read_url_content" || tool === "search_web") {
    const raw = value("Url", "url") ?? value("domain", "domain");
    if (raw === undefined) return null;
    try { return `read_url(${new URL(raw).hostname || raw})`; } catch { return `read_url(${raw})`; }
  }
  if (tool.startsWith("browser_")) {
    const raw = value("Url", "url") ?? value("domain", "domain");
    if (raw === undefined) return null;
    try { return `execute_url(${new URL(raw).hostname || raw})`; } catch { return `execute_url(${raw})`; }
  }
  if (tool === "ask_permission") {
    const action = value("Action", "action");
    const target = value("Target", "target");
    return action === undefined || target === undefined ? null : `${action}(${target})`;
  }
  // Antigravity does not document the hook name shape for MCP tools. Cover
  // the common provider/tool spellings without inventing a persistent scope.
  if (tool.startsWith("mcp__")) {
    const [server, ...parts] = tool.slice(5).split("__");
    return server && parts.length > 0 ? `mcp(${server}/${parts.join("__")})` : null;
  }
  return null;
}

/**
 * An Antigravity PreToolUse payload as the bridge's permission shape.
 * Known read-only and coordination tools stay in Antigravity's native policy.
 * Unknown tools are treated as custom/MCP tools because those default to Ask.
 */
export function antigravityPermission(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload) || !isObject(payload.toolCall)) return null;
  const tool = str(payload.toolCall.name);
  const session = str(payload.conversationId);
  if (tool === undefined || session === undefined || antigravityNeutralTools.has(tool)) return null;
  const args = isObject(payload.toolCall.args) ? payload.toolCall.args : {};
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const cwd = str(workspaces[0]) ?? str(args.Cwd) ?? str(args.cwd) ?? "";
  const resource = antigravityPermissionResource(tool, args);
  return {
    hook_event_name: "PermissionRequest",
    session_id: session,
    cwd,
    tool_name: antigravityToolLabel(tool),
    tool_input: normalizeToolInput(args),
    ...(resource === null ? {} : { permission_suggestions: [resource] }),
  };
}

/** Maps the bridge's shared permission decision to Antigravity's hook contract. */
export function antigravityPermissionReply(reply: unknown): Record<string, unknown> | null {
  if (!isObject(reply) || !isObject(reply.hookSpecificOutput) || !isObject(reply.hookSpecificOutput.decision)) return null;
  const decision = reply.hookSpecificOutput.decision;
  if (decision.behavior === "deny") return { decision: "deny", reason: "The user denied this permission in Hommies." };
  if (decision.behavior !== "allow") return null;
  const grants = Array.isArray(decision.updatedPermissions)
    ? decision.updatedPermissions.filter((entry: unknown): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  return { decision: "allow", ...(grants.length === 0 ? {} : { permissionOverrides: grants }) };
}

/**
 * The hook's reply once the bar answered: a deny whose reason carries the
 * answers. Antigravity shows the model the reason, so it continues with them
 * instead of asking again. Null (allow) when there is nothing to relay.
 */
export function antigravityAnswerReply(reply: unknown): { decision: "deny"; reason: string } | null {
  if (!isObject(reply) || !Array.isArray(reply.answers)) return null;
  const lines = reply.answers.flatMap((entry: unknown) => {
    if (!isObject(entry)) return [];
    const answer = str(entry.answer)?.trim();
    return answer ? [`- ${str(entry.question) ?? "Question"} \u2192 ${answer}`] : [];
  });
  if (lines.length === 0) return null;
  return {
    decision: "deny",
    reason: [
      "The user already answered this in Hommies (their desktop agent bar), so the question was not shown again:",
      ...lines,
      "Continue with these answers. Do not ask the question again.",
    ].join("\n"),
  };
}

/**
 * Grok Build's `ask_user_question` (PreToolUse, from the `question` hook
 * entry) as a Claude AskUserQuestion hook body, or null for any other tool.
 * Grok's options already carry `label` and `description`.
 */
export function grokQuestion(payload: unknown, env: Readonly<Record<string, string | undefined>>): Record<string, unknown> | null {
  if (!isObject(payload) || str(payload.subagentType) !== undefined) return null;
  if ((str(payload.tool_name) ?? str(payload.toolName)) !== "ask_user_question") return null;
  const input = isObject(payload.tool_input) ? payload.tool_input : isObject(payload.toolInput) ? payload.toolInput : {};
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions = raw.flatMap((question: unknown, index: number) => {
    if (!isObject(question)) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option: unknown) => {
      if (!isObject(option) || !str(option.label)) return [];
      return [{ label: str(option.label), ...(str(option.description) ? { description: str(option.description) } : {}) }];
    });
    return [{
      question: str(question.question) ?? `Question ${index + 1}`,
      header: raw.length > 1 ? `Question ${index + 1}` : "Question",
      options,
      multiSelect: question.multi_select === true || question.multiSelect === true,
    }];
  });
  const session = str(payload.session_id) ?? str(payload.sessionId) ?? str(env.GROK_SESSION_ID);
  if (questions.length === 0 || session === undefined) return null;
  const cwd = str(payload.cwd) ?? str(payload.workspaceRoot);
  return {
    hook_event_name: "PreToolUse",
    session_id: session,
    ...(cwd === undefined ? {} : { cwd }),
    tool_name: "AskUserQuestion",
    tool_use_id: str(payload.tool_use_id) ?? str(payload.toolUseId) ?? `${session}:${Date.now()}`,
    tool_input: { questions },
  };
}

/**
 * Grok's reply once the bar answered: a deny whose reason uses the same words
 * as Grok's own answered-questions tool result, so the model treats it as the
 * answer. Null (no output, i.e. allow) when there is nothing to relay.
 */
export function grokAnswerReply(reply: unknown): { decision: "deny"; reason: string } | null {
  if (!isObject(reply) || !Array.isArray(reply.answers)) return null;
  const entries = reply.answers.flatMap((entry: unknown) => {
    if (!isObject(entry)) return [];
    const answer = str(entry.answer)?.trim();
    return answer ? [`"${str(entry.question) ?? "Question"}"="${answer}"`] : [];
  });
  if (entries.length === 0) return null;
  return {
    decision: "deny",
    reason: `User has answered your questions: ${entries.join(", ")}. You can now continue with the user's answers in mind. ` +
      "(They answered in Hommies, their desktop agent bar, so the question was not shown again. Do not ask it again.)",
  };
}

interface QuestionRelay {
  readonly provider: "antigravity" | "grok";
  readonly toBody: (payload: unknown) => Record<string, unknown> | null;
  readonly toReply: (bridgeReply: unknown) => Record<string, unknown> | null;
  /** What to print when nothing is relayed; null prints nothing. */
  readonly allow: Record<string, unknown> | null;
}

/**
 * A question tool's PreToolUse (Antigravity's `ask_question`, Grok's
 * `ask_user_question`). Neither agent lets a hook fill in answers, so with the
 * top-bar answer surface the bridge holds the hook until the bar answers and
 * the hook denies the call with the answers as the reason, which the model
 * reads. Otherwise, and whenever anything fails, the call is allowed and the
 * agent asks in its own UI. Every other tool keeps the agent's permission flow.
 */
export async function runQuestionRelayHook(relay: QuestionRelay): Promise<void> {
  let output = relay.allow;
  try {
    const input = await readStdin();
    let payload: unknown;
    try { payload = JSON.parse(input); } catch { return; }
    const body = relay.toBody(payload);
    debugLog(relay.provider, input, null);
    if (body === null) return;
    const connection = await readConnection();
    if (connection === null) return;
    // Matches the bridge's wait for an answer (5 minutes) plus a margin.
    const reply = await postToBridge(connection, `/v1/providers/${relay.provider}/question`, JSON.stringify({ ...body, ...await agentProcess() }), 5 * 60 * 1000 + 5_000);
    if (reply.ok) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(reply.text); } catch { parsed = null; }
      output = relay.toReply(parsed) ?? output;
    }
  } catch {
    // The bar is optional; the agent still asks in its own UI.
  } finally {
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

/**
 * Antigravity has one PreToolUse surface for both questions and permissions.
 * An empty decision preserves its native policy when Hommies has no opinion.
 */
export async function runAntigravityPreToolHook(): Promise<void> {
  let output: Record<string, unknown> = { decision: "" };
  try {
    const input = await readStdin();
    let payload: unknown;
    try { payload = JSON.parse(input); } catch { return; }
    debugLog("antigravity", input, null);
    const question = antigravityQuestion(payload);
    const permission = question === null ? antigravityPermission(payload) : null;
    if (question === null && permission === null) return;
    // ask_question is safe to run when the optional bridge is absent. Other
    // calls keep the empty decision so Antigravity's own permission UI remains.
    if (question !== null) output = { decision: "allow" };
    const connection = await readConnection();
    if (connection === null) return;
    const route = question === null ? "permission" : "question";
    const body = question ?? permission;
    const reply = await postToBridge(connection, `/v1/providers/antigravity/${route}`,
      JSON.stringify({ ...body, ...await agentProcess() }), 5 * 60 * 1000 + 5_000);
    if (!reply.ok) return;
    let parsed: unknown = null;
    try { parsed = JSON.parse(reply.text); } catch { parsed = null; }
    output = question === null
      ? antigravityPermissionReply(parsed) ?? output
      : antigravityAnswerReply(parsed) ?? output;
  } catch {
    // The bridge is optional; fall through to Antigravity's native UI.
  } finally {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

/** Grok's `ask_user_question`; silence means allow. */
export const runGrokQuestionHook = (): Promise<void> => runQuestionRelayHook({
  provider: "grok", toBody: (payload) => grokQuestion(payload, process.env), toReply: grokAnswerReply, allow: null,
});

/**
 * Antigravity does not name the event in its payload, so setup passes it as
 * the hook's first argument. `PostToolUse` and `Stop` are reported here;
 * `PreToolUse` is handled by runAntigravityPreToolHook because its answer can
 * be either a question relay or a permission decision. The invocation events
 * fire on every model call rather than once per prompt.
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
      tool_already_ran: true,
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

/**
 * Opt-in: with HOMMIES_HOOK_LOG set (in the agent's environment), each hook
 * appends what it received and what it translated it to. For debugging new
 * agent versions; never on by default, since payloads carry prompts and code.
 * The log is owner-only: an existing symlink, another user's file, or a file
 * group or others can read is refused (see appendPrivateFile).
 */
function debugLog(provider: ForeignProvider, input: string, event: TranslatedEvent | null): void {
  const file = process.env.HOMMIES_HOOK_LOG;
  if (!file) return;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GROK_")));
    appendPrivateFile(file, `${JSON.stringify({ time: new Date().toISOString(), provider, argv: process.argv.slice(2), env, input, event })}\n`);
  } catch {
    // Debugging must never break the hook.
  }
}

export interface ForeignHookOptions {
  readonly provider: ForeignProvider;
  readonly translate: (payload: unknown) => TranslatedEvent | null;
  /** Gemini CLI and Antigravity read a JSON object from stdout on every hook. */
  readonly printJson: boolean;
  /** The final reply when a Stop payload does not carry it, e.g. from the agent's transcript. */
  readonly finalMessage?: (payload: unknown) => Promise<string | null>;
}

/** Reads the agent's payload, reports it, and never blocks or decides anything. */
export async function runForeignHook(options: ForeignHookOptions): Promise<void> {
  try {
    const input = await readStdin();
    let payload: unknown;
    try { payload = JSON.parse(input); } catch { return; }
    const event = options.translate(payload);
    debugLog(options.provider, input, event);
    if (event === null || typeof event.session_id !== "string") return;
    const connection = await readConnection();
    if (connection === null) return;
    const route = `/v1/providers/${options.provider}`;
    if (isActivityEvent(event)) return await reportActivity(route, event, connection);
    if (event.hook_event_name === "StopFailure") return await reportFailure(route, event, connection, null);
    if (isTurnEvent(event.hook_event_name)) {
      await reportTurn(route, event, connection, {
        // A Stop without a readable final message is still a finished turn.
        lastAssistantText: async () => (await options.finalMessage?.(payload).catch(() => null)) ?? "Turn finished.",
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
