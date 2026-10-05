#!/usr/bin/env node
/**
 * Command hook for Grok Build: live activity, turn ends, and failures, and
 * (with the `question` argument) its ask_user_question, answered from the bar.
 */
import { runForeignHook, runGrokQuestionHook, translateGrok } from "./foreign-hook.js";

// Setup registers a separate `ask_user_question` entry that passes `question`.
if (process.argv[2] === "question") void runGrokQuestionHook();
else void runForeignHook({ provider: "grok", translate: (payload) => translateGrok(payload, process.env), printJson: false });
