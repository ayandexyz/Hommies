import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readConnection } from "../dist/hook-common.js";
import { startBridgeServer } from "../dist/server.js";
import { runSetup } from "../dist/setup.js";

// Hommies was called agent-fold. Readers from before the rename (Omacode's
// built-in integration, older plugin copies, custom-agent hooks) still use the
// old folder, header, and variable names, so the bridge keeps accepting them.

test("the bridge accepts the token under the old header name", async () => {
  await withServer({}, async ({ url, token }) => {
    const current = await fetch(`${url}/v1/pending`, { headers: { "x-hommies-token": token } });
    assert.equal(current.status, 200);
    const legacy = await fetch(`${url}/v1/pending`, { headers: { "x-agent-fold-token": token } });
    assert.equal(legacy.status, 200);
    const wrong = await fetch(`${url}/v1/pending`, { headers: { "x-hommies-token": "nope", "x-agent-fold-token": "nope" } });
    assert.equal(wrong.status, 401);
  });
});

test("port.json is mirrored into the legacy folders, owner-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "hommies-legacy-mirror-"));
  try {
    const legacy = join(root, "agent-fold");
    await withServer({ dataDir: join(root, "hommies"), legacyDataDirs: [legacy] }, async ({ dataDir }) => {
      const current = await readFile(join(dataDir, "port.json"), "utf8");
      assert.equal(await readFile(join(legacy, "port.json"), "utf8"), current);
      assert.equal((await stat(join(legacy, "port.json"))).mode & 0o777, 0o600);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hooks find the bridge in the hommies folder, then the agent-fold one", async () => {
  const dataHome = await mkdtemp(join(tmpdir(), "hommies-legacy-read-"));
  const saved = saveEnv("XDG_DATA_HOME", "HOMMIES_DATA_DIR", "AGENT_FOLD_DATA_DIR");
  try {
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.HOMMIES_DATA_DIR;
    delete process.env.AGENT_FOLD_DATA_DIR;
    assert.equal(await readConnection(), null, "no bridge running");

    await writeConnection(join(dataHome, "agent-fold"), 1111);
    assert.equal((await readConnection())?.port, 1111, "a bridge from before the rename");

    await writeConnection(join(dataHome, "hommies"), 2222);
    assert.equal((await readConnection())?.port, 2222, "the hommies folder wins");

    const custom = join(dataHome, "custom");
    await writeConnection(custom, 3333);
    process.env.AGENT_FOLD_DATA_DIR = custom;
    assert.equal((await readConnection())?.port, 3333, "the old variable is still honoured");
  } finally {
    saved();
    await rm(dataHome, { recursive: true, force: true });
  }
});

test("setup names its backups <file>.hommies-backup-<time>", async () => {
  const home = await mkdtemp(join(tmpdir(), "hommies-legacy-backup-"));
  try {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude", "settings.json"), "{}");
    const [claude] = await runSetup(
      { uninstall: false, dryRun: false, providers: ["claude"] },
      { home, env: {}, distDir: "/opt/hommies/dist" },
    );
    assert.match(claude.backup, /settings\.json\.hommies-backup-[0-9TZ-]+$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function writeConnection(dir, port) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "port.json"), JSON.stringify({ port, token: "t", version: 1 }));
}

function saveEnv(...names) {
  const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function withServer(options, run) {
  const ownDir = options.dataDir === undefined ? await mkdtemp(join(tmpdir(), "hommies-legacy-test-")) : null;
  const dataDir = options.dataDir ?? ownDir;
  const server = await startBridgeServer({ port: 0, ...options, dataDir });
  try {
    const { token } = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    await run({ url: `http://127.0.0.1:${server.port}`, token, dataDir });
  } finally {
    await server.close();
    if (ownDir !== null) await rm(ownDir, { recursive: true, force: true });
  }
}
