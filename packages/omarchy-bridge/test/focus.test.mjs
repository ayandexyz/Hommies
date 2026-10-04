import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { focusCommands, pickClient, validTmux } from "../dist/focus.js";
import { ancestorPids, parentPid, processFields } from "../dist/process-tree.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("the parent pid is read past a command name with spaces and parens", () => {
  assert.equal(parentPid("4242 (tmux: server) S 1 4242 4242 0 -1"), 1);
  assert.equal(parentPid("77 (weird ) name)) R 76 77 0"), 76);
  assert.equal(parentPid("garbage"), null);
});

test("ancestry stops at init, on unreadable processes, and on loops", async () => {
  const parents = { 50: 40, 40: 30, 30: 1 };
  const read = async (pid) => (pid in parents ? `${pid} (x) S ${parents[pid]} 0` : null);
  assert.deepEqual(await ancestorPids(50, read), [50, 40, 30]);
  assert.deepEqual(await ancestorPids(99, read), [99]);
  assert.deepEqual(await ancestorPids(5, async (pid) => `${pid} (x) S ${pid === 5 ? 6 : 5} 0`), [5, 6]);
});

test("tmux fields are sent only inside tmux", async () => {
  const inside = await processFields(process.pid, { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%4" });
  assert.equal(inside.pids[0], process.pid);
  assert.deepEqual([inside.tmux_socket, inside.tmux_pane], ["/tmp/tmux-1000/default", "%4"]);
  const outside = await processFields(process.pid, {});
  assert.equal("tmux_pane" in outside, false);
});

test("the nearest ancestor's window wins, and a matching title breaks ties", () => {
  const clients = [
    { address: "0xa", pid: 10, title: "other" },
    { address: "0xb", pid: 20, title: "~/w/notes" },
    { address: "0xc", pid: 20, title: "~/w/app — Fix the build" },
  ];
  assert.equal(pickClient(clients, [99, 20, 10], ["Fix the build"]).address, "0xc");
  assert.equal(pickClient(clients, [99, 20, 10], []).address, "0xb");
  assert.equal(pickClient(clients, [10, 20], ["app"]).address, "0xa");
  assert.equal(pickClient(clients, [7], []), null);
});

test("focus tries Hyprland's Lua dispatch first, then the classic dispatcher", () => {
  assert.deepEqual(focusCommands("0xabc"), [
    ["dispatch", 'hl.dsp.focus({ window = "address:0xabc" })'],
    ["dispatch", "focuswindow", "address:0xabc"],
  ]);
});

test("tmux targets must look like tmux's own values", () => {
  assert.deepEqual(validTmux("/tmp/tmux-1000/default", "%3"), { socket: "/tmp/tmux-1000/default", pane: "%3" });
  assert.equal(validTmux("relative/sock", "%3"), undefined);
  assert.equal(validTmux("/tmp/sock", "3; rm -rf"), undefined);
  assert.equal(validTmux(undefined, "%3"), undefined);
});

test("POST /v1/focus focuses the session's terminal with its process ancestry", async () => {
  const targets = [];
  const focusWindow = async (target) => { targets.push(target); return target.pids.includes(300); };
  await withServer({ focusWindow }, async ({ request }) => {
    assert.equal((await request("POST", "/v1/focus", { threadId: "nope" })).status, 404);

    await request("POST", "/v1/providers/claude/activity", {
      hook_event_name: "SessionStart", session_id: "s1", cwd: "/w/app", pids: [100, 200, 300, "x", -4, 1],
      tmux_pane: "%2", tmux_socket: "/tmp/tmux-1000/default",
    });
    const session = (await pending(request)).sessions[0];
    assert.equal(session.focusable, true);
    assert.equal((await request("POST", "/v1/focus", { threadId: "s1" })).status, 200);
    assert.deepEqual(targets[0], { pids: [100, 200, 300], tmux: { socket: "/tmp/tmux-1000/default", pane: "%2" }, hints: ["app"] });

    await request("POST", "/v1/providers/claude/activity", { hook_event_name: "SessionStart", session_id: "s2", pids: [400] });
    assert.equal((await request("POST", "/v1/focus", { threadId: "s2" })).status, 404, "no window found");

    await request("POST", "/v1/providers/claude/activity", { hook_event_name: "SessionStart", session_id: "s3" });
    assert.equal((await pending(request)).sessions.find((entry) => entry.threadId === "s3").focusable, undefined);
  });
});

test("the compiled Claude hook sends the agent's process ancestry", async () => {
  const targets = [];
  await withServer({ focusWindow: async (target) => { targets.push(target); return true; } }, async ({ request, dataDir }) => {
    await runHook("claude-hook.js", { hook_event_name: "SessionStart", session_id: "k1", cwd: "/w/app" }, { HOMMIES_DATA_DIR: dataDir });
    assert.equal((await request("POST", "/v1/focus", { threadId: "k1" })).status, 200);
    // The hook's parent is this test process.
    assert.equal(targets[0].pids[0], process.pid);
  });
});

function runHook(script, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, script)], { env: { ...process.env, TMUX: "", TMUX_PANE: "", ...env } });
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
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-focus-test-"));
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
