#!/usr/bin/env node
// Drives the Hommie character through its moods by posting fake agent hooks
// to the running bridge. Every fake session id starts with "hommies-test-",
// so `reset` clears only what this script created.
//
//   node test-states.mjs            interactive menu
//   node test-states.mjs approval   switch to one state and keep it held
//   node test-states.mjs cycle 3    walk through every state, 3s each
//   node test-states.mjs emote dizzy  play one emote (shell IPC, no bridge needed)
//   node test-states.mjs emotes 3   play every emote, 3s apart

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const dataDir = process.env.HOMMIES_DATA_DIR
  ?? path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local/share"), "hommies");
const portFile = path.join(dataDir, "port.json");
if (!fs.existsSync(portFile)) {
  console.error(`No ${portFile}. Is the Hommies plugin (or hommies-bridge) running?`);
  process.exit(1);
}
const { port, token } = JSON.parse(fs.readFileSync(portFile, "utf8"));
const base = `http://127.0.0.1:${port}`;
const PREFIX = "hommies-test-";
const cwd = "/home/user/demo-project";

/** Blocking hook requests (permission, question) that are still open. Aborting one removes its item from the bar. */
const inFlight = new Set();

async function call(method, route, body, { block = false } = {}) {
  const controller = new AbortController();
  const request = fetch(base + route, {
    method,
    signal: controller.signal,
    headers: { "content-type": "application/json", "x-hommies-token": token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (block) {
    // The bridge holds these open until the bar answers, so do not await them.
    inFlight.add(controller);
    request.catch(() => {}).finally(() => inFlight.delete(controller));
    await new Promise((r) => setTimeout(r, 300));
    return null;
  }
  const response = await request;
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${json.error ?? ""}`);
  return json;
}

const sid = (name) => PREFIX + name;

async function reset() {
  for (const controller of inFlight) controller.abort();
  inFlight.clear();
  await new Promise((r) => setTimeout(r, 200));
  const snap = await call("GET", "/v1/pending");
  for (const thread of snap.threads ?? []) {
    if (!thread.threadId.startsWith(PREFIX)) continue;
    for (const item of thread.items ?? []) {
      await call("POST", "/v1/respond", { threadId: thread.threadId, requestId: item.id, decision: "cancel" }).catch(() => {});
    }
  }
  for (const session of snap.sessions ?? []) {
    if (!session.threadId.startsWith(PREFIX)) continue;
    await call("POST", `/v1/providers/${session.provider}/resume`, {
      hook_event_name: "SessionEnd", session_id: session.threadId, cwd,
    }).catch(() => {});
  }
}

const states = {
  idle: {
    label: "Idle: nothing pending",
    run: async () => {},
  },
  working: {
    label: "Working: a tool is running",
    run: () => call("POST", "/v1/providers/claude/activity", {
      hook_event_name: "PreToolUse", session_id: sid("working"), cwd,
      tool_name: "Bash", tool_input: { command: "pnpm build" },
    }),
  },
  thinking: {
    label: "Thinking: prompt submitted",
    run: () => call("POST", "/v1/providers/claude/resume", {
      hook_event_name: "UserPromptSubmit", session_id: sid("thinking"), cwd, prompt: "Fix the failing build",
    }),
  },
  approval: {
    label: "Approval: permission request (! badge, bounce)",
    run: () => call("POST", "/v1/providers/claude/permission", {
      hook_event_name: "PermissionRequest", session_id: sid("approval"), cwd,
      tool_name: "Bash", tool_input: { command: "git push origin main" },
    }, { block: true }),
  },
  question: {
    label: "Question: AskUserQuestion (? badge, tilt)",
    run: () => call("POST", "/v1/providers/claude/question", {
      hook_event_name: "PreToolUse", session_id: sid("question"), cwd,
      tool_name: "AskUserQuestion", tool_use_id: `toolu_${Date.now()}`,
      tool_input: {
        questions: [{
          question: "Which approach do you prefer?", header: "Approach", multiSelect: false,
          options: [{ label: "Option A", description: "First approach" }, { label: "Option B", description: "Second approach" }],
        }],
      },
    }, { block: true }),
  },
  error: {
    label: "Error: turn failed (shake)",
    run: () => call("POST", "/v1/providers/claude/failure", {
      hook_event_name: "StopFailure", session_id: sid("error"), cwd,
      error: "server_error", error_details: "500 Internal Server Error",
    }),
  },
  ratelimit: {
    label: "Rate limited (sweat)",
    run: () => call("POST", "/v1/providers/claude/failure", {
      hook_event_name: "StopFailure", session_id: sid("ratelimit"), cwd,
      error: "rate_limit", error_details: "429 Too Many Requests",
    }),
  },
  finished: {
    label: "Finished: turn complete (smile, sparks)",
    run: () => call("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: sid("finished"), cwd,
      last_assistant_message: "Done. The build passes and all tests are green.",
    }),
  },
  finishedBusy: {
    label: "Finished while another agent works (mood stays working, celebrate jump)",
    run: async () => {
      await states.working.run();
      await new Promise((r) => setTimeout(r, 1500));
      await states.finished.run();
    },
  },
  sleeping: {
    label: "Sleeping: not triggerable over HTTP (idle 10 min)",
    run: async () => console.log("  Sleep comes from Service.qml after 600s of idle. Stay on idle and wait, or use hommie-preview.html."),
  },
};
const names = Object.keys(states);

// Emotes are drawn by the character itself, so they go over shell IPC
// (`omarchy-shell hommies emote <name>`) instead of the bridge. Urgent moods
// (approval, question, error, ratelimit) block them; idle-only ones (wink,
// yawn, look) also need the idle mood.
const emotes = ["greet", "celebrate", "dizzy", "wink", "yawn", "look"];

function playEmote(name) {
  return new Promise((resolve, reject) => {
    execFile("omarchy-shell", ["hommies", "emote", name], (error, stdout) => {
      if (error) return reject(new Error(`omarchy-shell failed: ${error.message}`));
      const answer = stdout.trim();
      console.log(`  -> emote ${name}${answer && answer !== "ok" ? ` (${answer})` : ""}`);
      resolve();
    });
  });
}

async function cycleEmotes(seconds) {
  await reset();
  for (const name of emotes) {
    await playEmote(name);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

async function activate(name) {
  await reset();
  await states[name].run();
  console.log(`  -> ${name}`);
}

async function cycle(seconds) {
  for (const name of names.filter((n) => n !== "sleeping")) {
    await activate(name);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  await reset();
  console.log("  cycle done, back to idle");
}

async function shutdown() {
  await reset().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);

const [arg, extra] = process.argv.slice(2);
if (arg === "emote") {
  if (!emotes.includes(extra)) {
    console.error(`Unknown emote "${extra}". One of: ${emotes.join(", ")}`);
    process.exit(1);
  }
  await playEmote(extra);
  process.exit(0);
}
if (arg === "emotes") {
  await cycleEmotes(Number(extra) || 3);
  process.exit(0);
}
if (arg === "cycle") {
  await cycle(Number(extra) || 3);
  process.exit(0);
}
if (arg === "reset") {
  await reset();
  process.exit(0);
}
if (arg) {
  if (!states[arg]) {
    console.error(`Unknown state "${arg}". One of: ${names.join(", ")}, cycle, reset, emote <name>, emotes`);
    process.exit(1);
  }
  await activate(arg);
  console.log("  Holding. Ctrl+C to clear and exit.");
  setInterval(() => {}, 1 << 30);
} else {
  console.log(`Hommies state tester (bridge on port ${port})\n`);
  names.forEach((name, i) => console.log(`  ${i + 1}. ${states[name].label}`));
  console.log("\n  Emotes (idle mood for wink, yawn, look):");
  emotes.forEach((name, i) => console.log(`  e${i + 1}. ${name}`));
  console.log("\n  c. cycle all (3s each)   ce. cycle emotes   x. reset   q. quit\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", shutdown);
  const ask = () => rl.question("> ", async (input) => {
    const choice = input.trim().toLowerCase();
    try {
      if (choice === "q") return shutdown();
      if (choice === "c") await cycle(3);
      else if (choice === "ce") await cycleEmotes(3);
      else if (/^e\d+$/.test(choice) && emotes[Number(choice.slice(1)) - 1]) await playEmote(emotes[Number(choice.slice(1)) - 1]);
      else if (choice === "x") { await reset(); console.log("  -> reset"); }
      else if (names[Number(choice) - 1]) await activate(names[Number(choice) - 1]);
      else console.log("  ?");
    } catch (error) {
      console.error(`  ${error.message}`);
    }
    ask();
  });
  ask();
}
