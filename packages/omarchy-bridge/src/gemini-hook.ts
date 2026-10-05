#!/usr/bin/env node
/** Command hook for Gemini CLI: live activity and turn ends. Always prints `{}` (no decision). */
import { runForeignHook, translateGemini } from "./foreign-hook.js";

void runForeignHook({ provider: "gemini", translate: translateGemini, printJson: true });
