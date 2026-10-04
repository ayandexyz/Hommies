import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codexSessionTitle, lastCodexAssistantText } from "../dist/codex-transcript.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const message = (role, type, text) => JSON.stringify({
  type: "response_item", payload: { type: "message", role, content: [{ type, text }] },
});

test("the final assistant text is read from a Codex rollout", () => {
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: "/tmp" } }),
    message("user", "input_text", "fix it"),
    message("assistant", "output_text", "Looking."),
    JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec" } }),
    message("assistant", "output_text", "Two options."),
    message("assistant", "output_text", "Should I use A or B?"),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    "",
  ].join("\n");
  // "Looking." is commentary before the tool call, not part of the final message.
  assert.equal(lastCodexAssistantText(rollout), "Two options.\nShould I use A or B?");
  assert.equal(lastCodexAssistantText(message("user", "input_text", "hi")), null);
});

test("Codex session titles come from the latest session index entry", () => {
  const index = [
    JSON.stringify({ id: "c1", thread_name: "Old name", updated_at: "1" }),
    JSON.stringify({ id: "c2", thread_name: "Other", updated_at: "2" }),
    JSON.stringify({ id: "c1", thread_name: "Add  Codex parity", updated_at: "3" }),
  ].join("\n");
  assert.equal(codexSessionTitle(index, "c1"), "Add Codex parity");
  assert.equal(codexSessionTitle(index, "missing"), null);
});

test("Codex turn ends create Codex items, notifications, and clear on reply", async () => {
  const sent = [];
  await withServer({ notify: (notification) => sent.push(notification) }, async ({ request }) => {
    await request("POST", "/v1/providers/codex/stop", {
      hook_event_name: "Stop", session_id: "c1", cwd: "/home/me/proj",
      session_title: "Codex parity", last_assistant_message: "Want me to run the tests?",
    });
    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.threads[0].title, "Codex — proj");
    assert.equal(snapshot.threads[0].sessionTitle, "Codex parity");
    assert.equal(snapshot.threads[0].items[0].provider, "codex");
    assert.equal(snapshot.threads[0].items[0].kind, "attention");

    await request("POST", "/v1/providers/codex/resume", { hook_event_name: "UserPromptSubmit", session_id: "c1" });
    assert.equal((await pending(request)).totalCount, 0);
  });
  assert.deepEqual(sent, [{
    key: "c1", title: "Codex · Codex parity", body: "Waiting for your reply: Want me to run the tests?", urgency: "normal",
  }]);
});

test("the compiled Codex hook reads the rollout and session index", async () => {
  await withServer({}, async ({ request, dataDir }) => {
    const codexHome = join(dataDir, "codex");
    await mkdir(codexHome);
    await writeFile(join(codexHome, "session_index.jsonl"), JSON.stringify({ id: "c9", thread_name: "Rollout test" }) + "\n");
    const rollout = join(dataDir, "rollout.jsonl");
    await writeFile(rollout, [message("user", "input_text", "go"), message("assistant", "output_text", "All tests pass.")].join("\n"));

    const stdout = await runHook("codex-hook.js", { hook_event_name: "Stop", session_id: "c9", cwd: "/w/app",
      transcript_path: rollout, last_assistant_message: null, stop_hook_active: false,
      turn_id: "t", model: "m", permission_mode: "default" }, { HOMMIES_DATA_DIR: dataDir, CODEX_HOME: codexHome });
    assert.equal(stdout, "", "turn hooks never write to stdout");
    const thread = (await pending(request)).threads[0];
    assert.equal(thread.sessionTitle, "Rollout test");
    assert.deepEqual(thread.items.map((item) => [item.provider, item.kind, item.summary]), [["codex", "finished", "All tests pass."]]);

    assert.equal(await runHook("codex-hook.js", { hook_event_name: "SessionEnd", session_id: "c9", cwd: "/w/app",
      transcript_path: rollout, reason: "other" }, { HOMMIES_DATA_DIR: dataDir, CODEX_HOME: codexHome }), "");
    assert.equal((await pending(request)).totalCount, 0);
  });
});

test("the compiled Claude hook still reports turn ends after the refactor", async () => {
  await withServer({}, async ({ request, dataDir }) => {
    const transcript = join(dataDir, "claude.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ type: "ai-title", aiTitle: "Claude session" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Should I merge?" }] } }),
    ].join("\n"));
    const stdout = await runHook("claude-hook.js", { hook_event_name: "Stop", session_id: "k1", cwd: "/w/app",
      transcript_path: transcript, stop_hook_active: false }, { HOMMIES_DATA_DIR: dataDir });
    assert.equal(stdout, "");
    const thread = (await pending(request)).threads[0];
    assert.equal(thread.sessionTitle, "Claude session");
    assert.deepEqual(thread.items.map((item) => [item.provider, item.kind]), [["claude", "attention"]]);
  });
});

function runHook(script, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, script)], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function pending(request) {
  return request("GET", "/v1/pending").then((response) => response.json());
}

async function withServer(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-codex-test-"));
  const server = await startBridgeServer({ dataDir, port: 0, ...options });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-hommies-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request, dataDir });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
