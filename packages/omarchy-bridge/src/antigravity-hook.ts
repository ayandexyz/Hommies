#!/usr/bin/env node
/**
 * Command hook for Antigravity (`agy`): tool steps and turn ends. Antigravity's
 * payload does not name the event, so setup passes it as the first argument
 * (`antigravity-hook.js PostToolUse`). Always prints `{}` (no decision).
 */
import { runForeignHook, translateAntigravity } from "./foreign-hook.js";

const event = process.argv[2];
void runForeignHook({ provider: "antigravity", translate: (payload) => translateAntigravity(payload, event), printJson: true });
