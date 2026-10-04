#!/usr/bin/env node
/**
 * `hommies-hook --agent <name>` (`agent-fold-hook` before the rename): a command hook for any agent whose hooks
 * send Claude-style JSON on stdin. Reports activity, turn ends, and failures
 * to `/v1/agents/<name>/...`. It never blocks and never writes to stdout, so
 * permission requests stay in the agent's own prompt.
 *
 * The name comes from `--agent`, else `$HOMMIES_AGENT` (or the older
 * `$AGENT_FOLD_AGENT`), else an `agent`
 * field in the payload. Invalid or reserved names are dropped silently.
 */
import { isValidAgentName } from "./agent-name.js";
import {
  isActivityEvent, isTurnEvent, readConnection, readStdin, reportActivity, reportFailure, reportTurn,
  type ActivityHookEvent, type FailureHookEvent,
} from "./hook-common.js";

interface AgentHookEvent extends ActivityHookEvent, FailureHookEvent {
  readonly agent?: string;
  readonly session_title?: string;
}

function argumentName(argv: ReadonlyArray<string>): string | undefined {
  const flag = argv.findIndex((arg) => arg === "--agent");
  if (flag >= 0) return argv[flag + 1];
  return argv.find((arg) => arg.startsWith("--agent="))?.slice("--agent=".length);
}

async function main(): Promise<void> {
  const input = await readStdin();
  let event: AgentHookEvent;
  try { event = JSON.parse(input) as AgentHookEvent; } catch { return; }
  // `||`: an empty variable falls through to the payload field.
  const name = argumentName(process.argv.slice(2)) || process.env.HOMMIES_AGENT || process.env.AGENT_FOLD_AGENT || event.agent;
  if (typeof name !== "string" || !isValidAgentName(name) || typeof event.session_id !== "string") return;
  const connection = await readConnection();
  if (connection === null) return;
  const route = `/v1/agents/${name}`;
  const sessionTitle = typeof event.session_title === "string" && event.session_title.length > 0 ? event.session_title : null;

  if (isActivityEvent(event)) return reportActivity(route, event, connection);
  if (event.hook_event_name === "StopFailure") return reportFailure(route, event, connection, sessionTitle);
  if (isTurnEvent(event.hook_event_name)) {
    return reportTurn(route, event, connection, {
      // No transcript format to read: a Stop without its final message is still a finished turn.
      lastAssistantText: async () => "Turn finished.",
      sessionTitle: async () => sessionTitle,
    });
  }
  // PermissionRequest and anything else: no decision, the agent keeps its own prompt.
}

void main();
