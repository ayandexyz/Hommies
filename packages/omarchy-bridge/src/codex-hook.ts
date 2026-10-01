#!/usr/bin/env node
/** Command-hook adapter for Codex permission requests, turn ends, and live activity. */
import {
  agentProcess, isActivityEvent, isTurnEvent, postToBridge, readConnection, readStdin, reportActivity, reportTurn, type ActivityHookEvent,
} from "./hook-common.js";
import { lastCodexAssistantText, readCodexSessionTitle } from "./codex-transcript.js";
import { readTranscriptTail } from "./transcript.js";

async function main(): Promise<void> {
  const input = await readStdin();
  let event: ActivityHookEvent;
  try { event = JSON.parse(input) as ActivityHookEvent; } catch { return; }
  const connection = await readConnection();
  if (connection === null) return;
  if (isActivityEvent(event)) {
    await reportActivity("codex", event, connection);
    return;
  }
  if (isTurnEvent(event.hook_event_name)) {
    await reportTurn("codex", event, connection, {
      lastAssistantText: async ({ transcript_path }) => {
        const tail = await readTranscriptTail(transcript_path ?? undefined);
        return tail === null ? null : lastCodexAssistantText(tail);
      },
      sessionTitle: ({ session_id }) => readCodexSessionTitle(session_id),
    });
    return;
  }
  // Only PermissionRequest blocks; any other named event is not ours to answer.
  if (event.hook_event_name !== undefined && event.hook_event_name !== "PermissionRequest") return;
  try {
    // Label the session in the bar with the name Codex shows in `codex resume`.
    const sessionTitle = await readCodexSessionTitle(event.session_id);
    const body = JSON.stringify({ ...event, ...(sessionTitle === null ? {} : { session_title: sessionTitle }), ...await agentProcess() });
    const response = await postToBridge(connection, "/v1/providers/codex/permission", body, 5 * 60 * 1000 + 5_000);
    if (response.ok) process.stdout.write(await response.text());
  } catch {
    // Keep the native approval prompt when the optional bridge is unavailable.
  }
}

void main();
