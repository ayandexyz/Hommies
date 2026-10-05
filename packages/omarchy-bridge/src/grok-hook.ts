#!/usr/bin/env node
/** Command hook for Grok Build: live activity, turn ends, and failures. Never writes to stdout. */
import { runForeignHook, translateGrok } from "./foreign-hook.js";

void runForeignHook({ provider: "grok", translate: (payload) => translateGrok(payload, process.env), printJson: false });
