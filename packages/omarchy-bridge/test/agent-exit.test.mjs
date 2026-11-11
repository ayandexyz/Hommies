import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentIdentity, forkedSessionId, processRunning, statFields } from "../dist/process-tree.js";
import { startBridgeServer } from "../dist/server.js";

// pid (comm) state ppid ... with starttime as field 22.
const stat = (pid, comm, state, startTime) => `${pid} (${comm}) ${state} 1 ${"0 ".repeat(17)}${startTime} 0 0`;

test("stat fields survive command names with spaces and parens", () => {
  assert.deepEqual(statFields(stat(7, "tmux: (server)", "S", "4242")), { comm: "tmux: (server)", state: "S", startTime: "4242" });
  assert.equal(statFields("garbage"), null);
});

test("the agent is the nearest live process that is not a shell wrapper", async () => {
  const procs = { 10: stat(10, "sh", "S", "1"), 20: stat(20, "node", "Z", "2"), 30: stat(30, "claude", "S", "3"), 40: stat(40, "kitty", "S", "4") };
  const read = async (pid) => procs[pid] ?? null;
  assert.deepEqual(await agentIdentity([5, 10, 20, 30, 40], read), { pid: 30, startTime: "3" });
  assert.equal(await agentIdentity([5, 10], read), null);
});

test("a reused pid or a zombie does not count as the agent still running", async () => {
  const running = (line) => processRunning({ pid: 30, startTime: "3" }, async () => line);
  assert.equal(await running(stat(30, "claude", "S", "3")), true);
  assert.equal(await running(stat(30, "claude", "Z", "3")), false);
  assert.equal(await running(stat(30, "other", "S", "99")), false);
  assert.equal(await running(null), false);
});

test("a session is dropped, with its open requests, once its agent process exits", { timeout: 20000 }, async () => {
  const agent = spawn("sleep", ["60"], { stdio: "ignore" });
  await once(agent, "spawn");
  try {
    await withServer(async ({ request }) => {
      // OpenCode closed mid-turn: it never reports the turn's end.
      await request("POST", "/v1/providers/opencode/resume", {
        hook_event_name: "UserPromptSubmit", session_id: "gone", pids: [agent.pid, process.pid],
      });
      const hook = request("POST", "/v1/providers/opencode/permission", {
        session_id: "gone", cwd: "/w/app", request_id: "per_1", hook_event_name: "PermissionRequest",
        tool_name: "Bash", tool_input: { command: "pnpm test" }, pids: [agent.pid],
      });
      await request("POST", "/v1/providers/claude/resume", {
        hook_event_name: "UserPromptSubmit", session_id: "alive", pids: [process.pid],
      });
      await waitFor(request, (snapshot) => snapshot.totalCount === 1 && snapshot.sessions.length === 2);

      agent.kill();
      await once(agent, "exit");
      const snapshot = await waitFor(request, (next) => next.sessions.length === 1, 12000);
      assert.equal(snapshot.sessions[0].threadId, "alive");
      assert.equal(snapshot.totalCount, 0, "the dead agent's permission is gone too");
      await hook;
    });
  } finally {
    agent.kill();
  }
});

test("a forked Claude process names the session it was forked from", () => {
  // The command line Claude's background daemon starts a taken-over chat with.
  assert.equal(forkedSessionId([
    "/usr/bin/claude", "--session-id", "0a52ae5c-d47f-47aa-b53a-edcd9ce3da47", "--fork-session",
    "--resume", "/home/u/.claude/projects/-w/ccbeb49b-03f3-4514-9812-f5169b99a13f.jsonl", "--reply-on-resume",
  ]), "ccbeb49b-03f3-4514-9812-f5169b99a13f");
  assert.equal(forkedSessionId(["claude", "--fork-session", "--resume=abc-123"]), "abc-123");
  assert.equal(forkedSessionId(["claude", "--resume", "abc-123"]), null, "a plain resume continues the same session");
  assert.equal(forkedSessionId(["claude", "--session-id", "x", "--agent", "claude"]), null);
});

test("a session handed off to Claude's background daemon is dropped", { timeout: 10000 }, async () => {
  // 100 is the foreground claude; the daemon (300) runs the fork (400) under it.
  const forks = new Map([[400, "old"], [500, "live"]]);
  const agentProcesses = {
    identify: async (pids) => ({ pid: pids[0], startTime: "1" }),
    running: async () => true,
    forkedFrom: async (identity) => forks.get(identity.pid) ?? null,
  };
  await withServer(async ({ request }) => {
    await request("POST", "/v1/providers/claude/resume", {
      hook_event_name: "UserPromptSubmit", session_id: "old", pids: [100, 50],
    });
    await request("POST", "/v1/providers/claude/resume", {
      hook_event_name: "UserPromptSubmit", session_id: "live", pids: [200, 50],
    });
    await waitFor(request, (snapshot) => snapshot.sessions.length === 2);

    // A fork started in another terminal leaves the session it forked from alone.
    await request("POST", "/v1/providers/claude/resume", {
      hook_event_name: "UserPromptSubmit", session_id: "copy", pids: [500, 60],
    });
    await waitFor(request, (snapshot) => snapshot.sessions.length === 3);

    await request("POST", "/v1/providers/claude/resume", {
      hook_event_name: "UserPromptSubmit", session_id: "new", pids: [400, 300, 100, 50],
    });
    const snapshot = await waitFor(request, (next) => !next.sessions.some((session) => session.threadId === "old"));
    assert.deepEqual(snapshot.sessions.map((session) => session.threadId).sort(), ["copy", "live", "new"]);
  }, { agentProcesses });
});

async function waitFor(request, done, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await (await request("GET", "/v1/pending")).json();
    if (done(snapshot)) return snapshot;
    if (Date.now() > deadline) assert.fail(`timed out; last snapshot: ${JSON.stringify(snapshot)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withServer(run, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-exit-test-"));
  const server = await startBridgeServer({ dataDir, port: 0, ...options });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-hommies-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
