#!/usr/bin/env node
/**
 * Command-hook adapter for freecode's permission requests, mirrored
 * `question` tool calls, turn ends, and live activity.
 *
 * Unlike Claude/Codex, freecode's command hooks carry no stdin JSON and no
 * event-name env var: the event name arrives as `argv[2]` (set via each
 * HookSpec's `args` in setup.ts), and everything else arrives as
 * `CLAUDE_*`-prefixed env vars (freecode's own hook contract — see
 * apps/core/src/hooks/executors/command.ts upstream). This hook must never
 * read stdin: freecode never writes to or closes it, so `readStdin()` would
 * hang forever.
 */
import {
  agentProcess, isActivityEvent, isTurnEvent, postToBridge, readConnection, reportActivity, reportTurn,
  type ActivityHookEvent, type BridgeConnection, type TurnHookEvent,
} from "./hook-common.js";
import { lastFreecodeAssistantText, readFreecodeSessionTitle } from "./freecode-transcript.js";

type FreecodeEvent = ActivityHookEvent & TurnHookEvent;

/** freecode's AskUserQuestion-equivalent tool. */
const QUESTION_TOOL = "question";

function env(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildEvent(hookEventName: string): FreecodeEvent {
  const toolInput = (() => {
    const raw = env("CLAUDE_TOOL_INPUT");
    if (raw === undefined) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  })();
  return {
    hook_event_name: hookEventName,
    session_id: env("CLAUDE_SESSION_ID"),
    cwd: env("CLAUDE_CWD"),
    tool_name: env("CLAUDE_TOOL_NAME"),
    tool_input: toolInput,
    agent_id: env("CLAUDE_AGENT_ID"),
    agent_type: env("CLAUDE_AGENT_TYPE"),
    // freecode sends the prompt inside tool_input, not as a top-level field.
    prompt: hookEventName === "UserPromptSubmit" && typeof toolInput.prompt === "string" ? toolInput.prompt : undefined,
  } as FreecodeEvent;
}

async function main(): Promise<void> {
  const hookEventName = process.argv[2];
  if (typeof hookEventName !== "string" || hookEventName.length === 0) return;
  const event = buildEvent(hookEventName);
  const connection = await readConnection();
  if (connection === null) return;
  const toolUseId = env("CLAUDE_TOOL_USE_ID");

  if (hookEventName === "PreToolUse" && event.tool_name === QUESTION_TOOL && typeof toolUseId === "string") {
    await handleQuestionAsk(event, toolUseId, connection);
    return;
  }
  if ((hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") &&
    event.tool_name === QUESTION_TOOL && typeof toolUseId === "string") {
    await handleQuestionResolved(event, toolUseId, connection);
    return;
  }
  if (hookEventName === "PermissionRequest") {
    await handlePermission(event, connection);
    return;
  }
  if (isActivityEvent(event)) {
    await reportActivity("/v1/providers/freecode", event, connection);
    return;
  }
  if (isTurnEvent(hookEventName)) {
    await reportTurn("/v1/providers/freecode", event, connection, {
      lastAssistantText: ({ session_id, cwd }) => lastFreecodeAssistantText(cwd, session_id),
      sessionTitle: ({ session_id, cwd }) => readFreecodeSessionTitle(cwd, session_id),
    });
  }
}

/**
 * PreToolUse on the `question` tool: relabel to Claude's `AskUserQuestion`
 * for the wire protocol only (the bridge has no "freecode's question tool"
 * concept, just the shared mirrored-question shape), block for an answer.
 * On no answer (timeout, or the bridge's CLI-only surface) print nothing —
 * freecode's own `question` tool then runs exactly as asked, which is a
 * safe no-op, not a permission bypass.
 */
async function handleQuestionAsk(event: FreecodeEvent, toolUseId: string, connection: BridgeConnection): Promise<void> {
  try {
    const sessionTitle = await readFreecodeSessionTitle(event.cwd, event.session_id);
    const body = JSON.stringify({
      session_id: event.session_id,
      cwd: event.cwd,
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: event.tool_input,
      ...(sessionTitle === null ? {} : { session_title: sessionTitle }),
      ...await agentProcess(),
    });
    const response = await postToBridge(connection, "/v1/providers/freecode/question", body, 5 * 60 * 1000 + 5_000);
    if (!response.ok) return;
    const parsed = JSON.parse(response.text) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } };
    if (parsed.hookSpecificOutput?.updatedInput !== undefined) {
      process.stdout.write(JSON.stringify({ modifiedInput: parsed.hookSpecificOutput.updatedInput }));
    }
  } catch {
    // The bridge is optional; freecode's own question tool still prompts.
  }
}

/** PostToolUse/PostToolUseFailure on `question`: fire-and-forget, clears the mirrored item. */
async function handleQuestionResolved(event: FreecodeEvent, toolUseId: string, connection: BridgeConnection): Promise<void> {
  try {
    const body = JSON.stringify({
      session_id: event.session_id,
      cwd: event.cwd,
      hook_event_name: event.hook_event_name,
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: event.tool_input,
    });
    await postToBridge(connection, "/v1/providers/freecode/question/resolved", body, 2_000);
  } catch {
    // Best-effort, like every other resolved-detection path.
  }
}

/**
 * PermissionRequest: on no connection, an error, or a timeout, print
 * NOTHING — freecode's PermissionRequest hooks treat a matched hook with no
 * explicit `permissionDecision` as passthrough, not an implicit allow (see
 * apps/core/src/hooks/PermissionRequest.ts upstream), so staying silent here
 * is safe. Only an actual decision from the bridge is translated.
 */
async function handlePermission(event: FreecodeEvent, connection: BridgeConnection): Promise<void> {
  try {
    const sessionTitle = await readFreecodeSessionTitle(event.cwd, event.session_id);
    const body = JSON.stringify({
      session_id: event.session_id,
      cwd: event.cwd,
      hook_event_name: "PermissionRequest",
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      ...(sessionTitle === null ? {} : { session_title: sessionTitle }),
      ...await agentProcess(),
    });
    const response = await postToBridge(connection, "/v1/providers/freecode/permission", body, 5 * 60 * 1000 + 5_000);
    if (!response.ok) return;
    const parsed = JSON.parse(response.text) as {
      hookSpecificOutput?: { decision?: { behavior?: "allow" | "deny" | "unchanged" } };
    };
    const decision = parsed.hookSpecificOutput?.decision;
    if (decision === undefined || decision.behavior === "unchanged") return;
    // The bridge's decision carries no reason text (see server.ts's
    // `permissionDecision()`/`receivePermission()` upstream — `behavior`
    // only), so there is nothing to forward as `context` either way.
    process.stdout.write(JSON.stringify({ permissionDecision: decision.behavior === "deny" ? "deny" : "allow" }));
  } catch {
    // Silent on failure too — passthrough, never an implicit allow.
  }
}

void main();
