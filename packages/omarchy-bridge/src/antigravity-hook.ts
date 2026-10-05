#!/usr/bin/env node
/**
 * Command hook for Antigravity (`agy`): questions, permissions, tool steps, and turn ends. Antigravity's
 * payload does not name the event, so setup passes it as the first argument
 * (`antigravity-hook.js PostToolUse`). Every invocation prints valid JSON.
 */
import { lastAntigravityText, runAntigravityPreToolHook, runForeignHook, translateAntigravity } from "./foreign-hook.js";
import { readTranscriptTail } from "./transcript.js";

const event = process.argv[2];
if (event === "PreToolUse") {
  void runAntigravityPreToolHook();
} else {
  void runForeignHook({
    provider: "antigravity",
    translate: (payload) => translateAntigravity(payload, event),
    printJson: true,
    finalMessage: async (payload) => {
      const path = payload !== null && typeof payload === "object" ? (payload as { transcriptPath?: unknown }).transcriptPath : undefined;
      const tail = typeof path === "string" ? await readTranscriptTail(path) : null;
      return tail === null ? null : lastAntigravityText(tail);
    },
  });
}
