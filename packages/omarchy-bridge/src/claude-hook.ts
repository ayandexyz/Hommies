#!/usr/bin/env node
/** Command-hook adapter for Claude Code questions, permissions, turn ends, failures, and live activity. */
import { claudeElicitationQuestion, claudeElicitationReply, claudeElicitationResolved } from "./claude-elicitation.js";
import {
  agentProcess, isActivityEvent, isTurnEvent, postToBridge, readConnection, readStdin, reportActivity, reportFailure, reportTurn,
  type ActivityHookEvent, type FailureHookEvent,
} from "./hook-common.js";
import { lastAssistantText } from "./stop-detection.js";
import { readSessionTitle, readTranscriptTail } from "./transcript.js";

type HookEvent = ActivityHookEvent & FailureHookEvent;

async function main(): Promise<void> {
  // Grok Build also runs Claude Code's hooks from .claude/settings.json. Its own
  // hook (grok-hook.js) reports those sessions, and Grok ignores Claude-style
  // decisions, so stay silent rather than list the session twice under Claude.
  if (process.env.GROK_HOOK_EVENT) return;
  const input = await readStdin();
  let event: HookEvent;
  try { event = JSON.parse(input) as HookEvent; } catch { return; }
  const connection = await readConnection();
  if (connection === null) return;
  if (event.hook_event_name === "Elicitation") {
    const question = claudeElicitationQuestion(event);
    if (question === null) return;
    try {
      const response = await postToBridge(connection, "/v1/providers/claude/question",
        JSON.stringify({ ...question, ...await agentProcess() }), 5 * 60 * 1000 + 5_000);
      if (!response.ok) return;
      let reply: unknown = null;
      try { reply = JSON.parse(response.text); } catch { reply = null; }
      const output = claudeElicitationReply(event, reply);
      if (output !== null) process.stdout.write(JSON.stringify(output));
    } catch {
      // Unsupported forms and bridge failures preserve Claude's native dialog.
    }
    return;
  }
  if (event.hook_event_name === "ElicitationResult") {
    const resolved = claudeElicitationResolved(event);
    if (resolved !== null) {
      try {
        await postToBridge(connection, "/v1/providers/claude/question/resolved", JSON.stringify(resolved), 2_000);
      } catch {
        // The bridge is optional.
      }
    }
    return;
  }
  if (isActivityEvent(event)) {
    await reportActivity("/v1/providers/claude", event, connection);
    return;
  }
  if (event.hook_event_name === "StopFailure") {
    await reportFailure("/v1/providers/claude", event, connection, await readSessionTitle(event.transcript_path ?? undefined));
    return;
  }
  if (isTurnEvent(event.hook_event_name)) {
    await reportTurn("/v1/providers/claude", event, connection, {
      lastAssistantText: async ({ transcript_path }) => {
        const tail = await readTranscriptTail(transcript_path ?? undefined);
        return tail === null ? null : lastAssistantText(tail);
      },
      sessionTitle: ({ transcript_path }) => readSessionTitle(transcript_path ?? undefined),
    });
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
    const sessionTitle = resolvingQuestion ? null : await readSessionTitle(event.transcript_path ?? undefined);
    const body = resolvingQuestion
      ? input
      : JSON.stringify({ ...event, ...(sessionTitle === null ? {} : { session_title: sessionTitle }), ...await agentProcess() });
    const response = await postToBridge(connection, path, body, 5 * 60 * 1000 + 5_000);
    if (response.ok) process.stdout.write(response.text);
  } catch {
    // The bridge is optional; preserve Claude Code's native permission prompt.
  }
}

void main();
