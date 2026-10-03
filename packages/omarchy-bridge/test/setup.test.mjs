import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isAgentFoldCommand, mergeClaudeSettings, mergeOpenCodeConfig, runSetup } from "../dist/setup.js";

const install = { uninstall: false, dryRun: false, providers: ["claude", "codex", "opencode"] };
const uninstall = { ...install, uninstall: true };
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "agent-fold-setup-"));
  try {
    await run({ home, environment: { home, env: {}, distDir: "/opt/agent-fold/dist" } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("hook commands are recognized across install locations", () => {
  assert.ok(isAgentFoldCommand("node /usr/lib/node_modules/@thisisayande/agent-fold/dist/claude-hook.js", "claude-hook.js"));
  assert.ok(isAgentFoldCommand("node /usr/lib/node_modules/@thisisayande/hommies/dist/claude-hook.js", "claude-hook.js"));
  assert.ok(isAgentFoldCommand(
    "test -f /usr/lib/node_modules/@thisisayande/hommies/dist/claude-hook.js && node /usr/lib/node_modules/@thisisayande/hommies/dist/claude-hook.js || true",
    "claude-hook.js"));
  assert.ok(isAgentFoldCommand("node /src/agent-fold/packages/omarchy-bridge/dist/claude-hook.js", "claude-hook.js"));
  assert.ok(isAgentFoldCommand("agent-fold-claude-hook", "claude-hook.js"));
  assert.ok(!isAgentFoldCommand("node /other/tool/claude-hook.js", "claude-hook.js"));
  assert.ok(!isAgentFoldCommand("node /opt/agent-fold/dist/codex-hook.js", "claude-hook.js"));
});

test("Claude hooks merge beside the user's own hooks and replace stale agent-fold entries", () => {
  const userStop = { hooks: [{ type: "command", command: "say done" }] };
  const settings = {
    model: "opus",
    hooks: {
      Stop: [userStop, { hooks: [{ type: "command", command: "node /old/agent-fold/dist/claude-hook.js", timeout: 5 }] }],
    },
  };
  const next = mergeClaudeSettings(settings, "node /new/agent-fold/dist/claude-hook.js");
  assert.equal(next.model, "opus");
  assert.deepEqual(next.hooks.Stop, [userStop, { hooks: [{ type: "command", command: "node /new/agent-fold/dist/claude-hook.js", timeout: 5 }] }]);
  assert.deepEqual(next.hooks.PreToolUse, [{ matcher: "*", hooks: [{ type: "command", command: "node /new/agent-fold/dist/claude-hook.js" }] }]);
  assert.deepEqual(next.hooks.PostToolUse, [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node /new/agent-fold/dist/claude-hook.js" }] }]);
  assert.equal(next.hooks.SessionStart[0].hooks[0].timeout, 5);
  assert.equal(next.hooks.StopFailure[0].hooks[0].timeout, 5);
  assert.equal(next.hooks.PermissionRequest[0].hooks[0].timeout, 305);
  assert.deepEqual(mergeClaudeSettings(next, "node /new/agent-fold/dist/claude-hook.js"), next, "setup is idempotent");
  assert.deepEqual(mergeClaudeSettings(next, null), { model: "opus", hooks: { Stop: [userStop] } });
});

test("uninstall leaves configs without agent-fold entries untouched", () => {
  const settings = { hooks: {} };
  assert.equal(mergeClaudeSettings(settings, null), settings);
  const openCode = { plugin: [] };
  assert.equal(mergeOpenCodeConfig(openCode, null), openCode);
});

test("OpenCode keeps other plugins and swaps the agent-fold entry", () => {
  const config = { plugin: ["opencode-foo", "file:///old/@agent-fold/bridge/dist/opencode-plugin.js"] };
  assert.deepEqual(mergeOpenCodeConfig(config, "file:///opt/agent-fold/dist/opencode-plugin.js").plugin,
    ["opencode-foo", "file:///opt/agent-fold/dist/opencode-plugin.js"]);
  assert.deepEqual(mergeOpenCodeConfig(config, null), { plugin: ["opencode-foo"] });
});

test("setup writes each installed agent's config, backs up, and uninstall restores it", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    const settings = join(home, ".claude", "settings.json");
    await writeFile(settings, JSON.stringify({ theme: "dark" }));

    const results = await runSetup(install, environment);
    assert.deepEqual(results.map((result) => [result.provider, result.status]),
      [["claude", "updated"], ["codex", "skipped"], ["opencode", "updated"]]);
    assert.ok(results[0].backup, "an existing file is backed up");
    assert.deepEqual(JSON.parse(await readFile(results[0].backup, "utf8")), { theme: "dark" });

    const written = await readJson(settings);
    assert.equal(written.theme, "dark");
    assert.equal(written.hooks.Stop[0].hooks[0].command,
      "test -f /opt/agent-fold/dist/claude-hook.js && node /opt/agent-fold/dist/claude-hook.js || true");
    assert.deepEqual((await readJson(join(home, ".config", "opencode", "opencode.json"))).plugin,
      ["file:///opt/agent-fold/dist/opencode-plugin.js"]);

    assert.deepEqual((await runSetup(install, environment)).map((result) => result.status), ["unchanged", "skipped", "unchanged"]);

    await runSetup(uninstall, environment);
    assert.deepEqual(await readJson(settings), { theme: "dark" });
    assert.deepEqual(await readJson(join(home, ".config", "opencode", "opencode.json")), {});
  });
});

test("dry runs, invalid JSON, and JSONC configs are never written", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{ not json");
    await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), "{}");

    const dry = await runSetup({ ...install, dryRun: true }, environment);
    assert.deepEqual(dry.map((result) => result.status), ["error", "updated", "skipped"]);
    assert.deepEqual(await readdir(join(home, ".codex")), [], "dry run writes nothing");
    assert.equal(await readFile(join(home, ".claude", "settings.json"), "utf8"), "{ not json");
  });
});

test("a symlinked config is updated through the link", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".codex"));
    await mkdir(join(home, "dotfiles"));
    const real = join(home, "dotfiles", "hooks.json");
    await writeFile(real, "{}");
    await symlink(real, join(home, ".codex", "hooks.json"));

    await runSetup({ ...install, providers: ["codex"] }, environment);
    const hooks = (await readJson(real)).hooks;
    assert.deepEqual(hooks.PermissionRequest, [{ matcher: "*", hooks: [{ type: "command", command: "test -f /opt/agent-fold/dist/codex-hook.js && node /opt/agent-fold/dist/codex-hook.js || true", timeout: 305 }] }]);
  });
});
