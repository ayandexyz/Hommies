import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isValidAgentName } from "../dist/agent-name.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("custom agent names are short, lowercase, and never a built-in name", () => {
  for (const name of ["aider", "my-tool", "a", "x".repeat(24), "gemini-2"]) assert.ok(isValidAgentName(name), name);
  for (const name of ["", "Aider", "my_tool", "x".repeat(25), "claude", "codex", "opencode", "omacode", "cursor", "a/b"]) {
    assert.ok(!isValidAgentName(name), name);
  }
});

test("custom agents get their own sessions, items, and labels", async () => {
  const sent = [];
  await withServer({ notify: (notification) => sent.push(notification) }, async ({ request }) => {
    const post = (path, body) => request("POST", `/v1/agents/aider${path}`, { session_id: "a1", cwd: "/w/app", ...body });
    await post("/resume", { hook_event_name: "UserPromptSubmit", prompt: "add tests" });
    await post("/activity", { hook_event_name: "PreToolUse", tool_name: "shell", tool_input: { command: "pytest" } });
    let snapshot = await pending(request);
    assert.deepEqual(snapshot.sessions.map((session) => [session.provider, session.state, session.steps]),
      [["aider", "working", ["> add tests", "shell pytest"]]]);

    await post("/stop", { hook_event_name: "Stop", last_assistant_message: "Should I commit?" });
    snapshot = await pending(request);
    assert.equal(snapshot.threads[0].title, "aider — app");
    assert.deepEqual(snapshot.threads[0].items.map((item) => [item.provider, item.kind]), [["aider", "attention"]]);
    assert.equal(sent[0].title, "aider");

    await post("/failure", { error: "rate_limit" });
    assert.equal((await pending(request)).sessions[0].state, "ratelimit");
  });
});

test("invalid or reserved agent names are rejected", async () => {
  await withServer({}, async ({ request }) => {
    for (const name of ["claude", "Bad", "x".repeat(25), "a%2Fb"]) {
      const response = await request("POST", `/v1/agents/${name}/activity`, { hook_event_name: "SessionStart", session_id: "x" });
      assert.equal(response.status, 400, name);
    }
    assert.deepEqual((await pending(request)).sessions, []);
  });
});

test("hommies-hook reports a custom agent and never answers permissions", async () => {
  await withServer({}, async ({ request, dataDir }) => {
    const env = { HOMMIES_DATA_DIR: dataDir };
    assert.equal(await runHook(["--agent", "my-tool"], { hook_event_name: "PreToolUse", session_id: "m1", cwd: "/w/app",
      tool_name: "Edit", tool_input: { file_path: "/w/app/a.ts" } }, env), "");
    assert.equal(await runHook(["--agent", "my-tool"], { hook_event_name: "PermissionRequest", session_id: "m1",
      tool_name: "Bash", tool_input: { command: "rm -rf /" } }, env), "", "no decision is written");
    assert.equal(await runHook([], { hook_event_name: "Stop", session_id: "m2", agent: "other-tool" }, env), "");
    assert.equal(await runHook(["--agent", "claude"], { hook_event_name: "SessionStart", session_id: "m3" }, env), "");

    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 1, "only the Stop became an item");
    assert.deepEqual(snapshot.sessions.map((session) => [session.threadId, session.provider]).sort(),
      [["m1", "my-tool"], ["m2", "other-tool"]]);
    assert.deepEqual(snapshot.threads[0].items.map((item) => [item.provider, item.kind, item.summary]),
      [["other-tool", "finished", "Turn finished."]]);
  });
});

function runHook(args, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, "agent-hook.js"), ...args], {
      env: { ...process.env, HOMMIES_AGENT: "", AGENT_FOLD_AGENT: "", ...env },
    });
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
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-agents-test-"));
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
