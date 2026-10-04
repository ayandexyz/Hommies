import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";
import { checkHooks, commandHookFingerprint, connectedHookProviders, outdatedHookProviders, runSetup } from "../dist/setup.js";

const install = { uninstall: false, dryRun: false, providers: ["claude", "codex", "opencode"] };

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "hommies-check-"));
  try {
    await run({ home, environment: { home, env: {}, distDir: "/opt/hommies/dist" } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const statuses = async (environment) => (await checkHooks(environment)).map((check) => [check.provider, check.status]);

test("hook checks report missing, current, and outdated hooks", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".codex"));
    assert.deepEqual(await statuses(environment), [["claude", "missing"], ["codex", "missing"], ["opencode", "not-installed"]]);

    await runSetup(install, environment);
    assert.deepEqual(await statuses(environment), [["claude", "current"], ["codex", "current"], ["opencode", "not-installed"]]);

    // An install from an older version: only the permission hook, at an old path.
    const settings = join(home, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [
      { type: "command", command: "node /old/agent-fold/dist/claude-hook.js", timeout: 305 },
    ] }] } }));
    assert.deepEqual((await statuses(environment))[0], ["claude", "outdated"]);
    assert.deepEqual(await outdatedHookProviders(environment), ["claude"]);

    await writeFile(settings, "{ not json");
    assert.deepEqual((await statuses(environment))[0], ["claude", "error"]);
  });
});

test("the fingerprint ignores the order of the user's own hooks", () => {
  const ours = { type: "command", command: "node /opt/hommies/dist/claude-hook.js", timeout: 5 };
  const theirs = { type: "command", command: "say done" };
  const before = { hooks: { Stop: [{ hooks: [ours] }, { hooks: [theirs] }] } };
  const after = { hooks: { Stop: [{ hooks: [theirs] }, { hooks: [ours] }] } };
  assert.deepEqual(commandHookFingerprint(before, "claude-hook.js"), commandHookFingerprint(after, "claude-hook.js"));
  assert.equal(commandHookFingerprint(before, "claude-hook.js").length, 1);
});

test("the bridge publishes outdated hooks only when there are some", async () => {
  let outdated = ["codex", "claude"];
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-check-bridge-"));
  const server = await startBridgeServer({ dataDir, port: 0, checkHooks: async () => outdated });
  try {
    const { token } = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const pending = async () => (await fetch(`http://127.0.0.1:${server.port}/v1/pending`, { headers: { "x-hommies-token": token } })).json();
    assert.deepEqual((await pending()).hooksOutdated, ["claude", "codex"]);
    outdated = [];
    const fresh = await startBridgeServer({ dataDir: join(dataDir, "second"), port: 0, checkHooks: async () => outdated });
    try {
      const second = JSON.parse(await readFile(join(dataDir, "second", "port.json"), "utf8"));
      const snapshot = await (await fetch(`http://127.0.0.1:${fresh.port}/v1/pending`, { headers: { "x-hommies-token": second.token } })).json();
      assert.equal("hooksOutdated" in snapshot, false);
    } finally {
      await fresh.close();
    }
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("connected agents are the ones with Hommies hooks, current or outdated", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    assert.deepEqual(await connectedHookProviders(environment), [], "installed but not set up");

    await runSetup({ ...install, providers: ["claude", "opencode"] }, environment);
    assert.deepEqual(await connectedHookProviders(environment), ["claude", "opencode"]);

    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: "command", command: "node /old/agent-fold/dist/claude-hook.js" },
    ] }] } }));
    assert.deepEqual(await connectedHookProviders(environment), ["claude", "opencode"], "outdated hooks still connect");
  });
});

test("the bridge publishes the connected agents", async () => {
  let connected = ["opencode", "claude"];
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-connected-bridge-"));
  const server = await startBridgeServer({ dataDir, port: 0, connectedAgents: async () => connected });
  try {
    const { token } = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const pending = async () => (await fetch(`http://127.0.0.1:${server.port}/v1/pending`, { headers: { "x-hommies-token": token } })).json();
    assert.deepEqual((await pending()).hooksConnected, ["claude", "opencode"]);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  const bare = await startBridgeServer({ dataDir, port: 0 });
  try {
    const { token } = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const snapshot = await (await fetch(`http://127.0.0.1:${bare.port}/v1/pending`, { headers: { "x-hommies-token": token } })).json();
    assert.equal("hooksConnected" in snapshot, false, "absent when the bridge was not asked to check");
  } finally {
    await bare.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
