import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { describeStep, startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("steps name the tool and its target", () => {
  assert.equal(describeStep("Bash", { command: "pnpm test\necho done" }), "Bash pnpm test");
  assert.equal(describeStep("Edit", { file_path: "/w/app/src/server.ts" }), "Edit server.ts");
  assert.equal(describeStep("Grep", { pattern: "TODO" }), "Grep TODO");
  assert.equal(describeStep("mcp__github__get_issue", {}), "github · get_issue");
  assert.equal(describeStep("TodoWrite", { todos: [] }), "TodoWrite");
  assert.equal(describeStep("Bash", { command: "x".repeat(100) }).length, "Bash ".length + 60);
});

test("a session moves from thinking to working to idle and ends", async () => {
  await withServer(async ({ request }) => {
    const activity = (body) => request("POST", "/v1/providers/claude/activity", { session_id: "s1", cwd: "/w/app", ...body });

    assert.equal((await activity({ hook_event_name: "SessionStart" })).status, 200);
    assert.deepEqual(sessionsOf(await pending(request)), [["s1", "claude", "idle", []]]);

    await request("POST", "/v1/providers/claude/resume", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "fix the\nbuild" });
    assert.deepEqual(sessionsOf(await pending(request)), [["s1", "claude", "thinking", ["> fix the"]]]);

    await activity({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pnpm build" } });
    await activity({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "pnpm build" } });
    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 0, "activity is not a pending item");
    assert.deepEqual(sessionsOf(snapshot), [["s1", "claude", "working", ["> fix the", "Bash pnpm build", "Bash pnpm build (failed)"]]]);
    assert.equal(snapshot.sessions[0].project, "app");

    await request("POST", "/v1/providers/claude/stop", { hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Fixed it." });
    assert.equal(sessionsOf(await pending(request))[0][2], "idle");

    await request("POST", "/v1/providers/claude/resume", { hook_event_name: "SessionEnd", session_id: "s1" });
    assert.deepEqual((await pending(request)).sessions, []);
  });
});

test("a session keeps only its latest steps and rejects unknown events", async () => {
  await withServer(async ({ request }) => {
    for (let index = 0; index < 25; index++) {
      await request("POST", "/v1/providers/codex/activity", {
        hook_event_name: "PreToolUse", session_id: "c1", tool_name: "Read", tool_input: { file_path: `/f${index}` },
      });
    }
    const steps = (await pending(request)).sessions[0].steps;
    assert.equal(steps.length, 20);
    assert.equal(steps.at(-1), "Read f24");
    const bad = await request("POST", "/v1/providers/codex/activity", { hook_event_name: "Stop", session_id: "c1" });
    assert.equal(bad.status, 400);
  });
});

test("a tool call clears the session's turn-end item", async () => {
  await withServer(async ({ request }) => {
    await request("POST", "/v1/providers/claude/stop", { hook_event_name: "Stop", session_id: "s2", last_assistant_message: "Should I continue?" });
    assert.equal((await pending(request)).totalCount, 1);
    await request("POST", "/v1/providers/claude/activity", { hook_event_name: "PreToolUse", session_id: "s2", tool_name: "Read", tool_input: {} });
    assert.equal((await pending(request)).totalCount, 0);
  });
});

test("the compiled Claude hook reports tool calls silently and keeps AskUserQuestion blocking", async () => {
  await withServer(async ({ request, dataDir }) => {
    const env = { AGENT_FOLD_DATA_DIR: dataDir };
    const stdout = await runHook("claude-hook.js", {
      hook_event_name: "PreToolUse", session_id: "k1", cwd: "/w/app", tool_name: "Write",
      tool_input: { file_path: "/w/app/big.txt", content: "x".repeat(10_000) },
    }, env);
    assert.equal(stdout, "", "activity hooks never write to stdout");
    assert.equal(await runHook("claude-hook.js", { hook_event_name: "SessionStart", session_id: "k1", cwd: "/w/app", source: "startup" }, env), "");
    assert.deepEqual(sessionsOf(await pending(request)), [["k1", "claude", "working", ["Write big.txt"]]]);

    const question = runHook("claude-hook.js", {
      hook_event_name: "PreToolUse", session_id: "k1", cwd: "/w/app", tool_name: "AskUserQuestion", tool_use_id: "t1",
      tool_input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }], multiSelect: false }] },
    }, env);
    let snapshot;
    for (let attempt = 0; attempt < 50; attempt++) {
      snapshot = await pending(request);
      if (snapshot.totalCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const item = snapshot.threads[0].items[0];
    assert.equal(item.kind, "question");
    await request("POST", "/v1/respond", { threadId: "k1", requestId: item.id, answers: { "Which?": "A" } });
    const output = JSON.parse(await question);
    assert.equal(output.hookSpecificOutput.updatedInput.answers["Which?"], "A");
  });
});

test("the compiled Codex hook reports tool calls without answering them", async () => {
  await withServer(async ({ request, dataDir }) => {
    const stdout = await runHook("codex-hook.js", {
      hook_event_name: "PreToolUse", session_id: "c2", cwd: "/w/app", tool_name: "Bash", tool_input: { command: "ls -la" },
    }, { AGENT_FOLD_DATA_DIR: dataDir });
    assert.equal(stdout, "");
    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 0, "a tool call is never sent as a permission");
    assert.deepEqual(sessionsOf(snapshot), [["c2", "codex", "working", ["Bash ls -la"]]]);
  });
});

function sessionsOf(snapshot) {
  return snapshot.sessions.map((session) => [session.threadId, session.provider, session.state, session.steps]);
}

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

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-activity-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-agent-fold-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request, dataDir });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
