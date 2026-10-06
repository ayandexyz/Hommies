import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkHooks, detectOpenCodeMajors, isHommiesCommand, linkBridgeCommand, mergeClaudeSettings, mergeOpenCodeConfig, runSetup } from "../dist/setup.js";

const install = { uninstall: false, dryRun: false, providers: ["claude", "codex", "opencode"] };
const uninstall = { ...install, uninstall: true };
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "hommies-setup-"));
  try {
    await run({ home, environment: { home, env: {}, distDir: "/opt/hommies/dist" } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("hook commands are recognized across install locations", () => {
  assert.ok(isHommiesCommand("node /usr/lib/node_modules/@thisisayande/agent-fold/dist/claude-hook.js", "claude-hook.js"));
  assert.ok(isHommiesCommand("node /usr/lib/node_modules/@thisisayande/hommies/dist/claude-hook.js", "claude-hook.js"));
  assert.ok(isHommiesCommand(
    "test -f /usr/lib/node_modules/@thisisayande/hommies/dist/claude-hook.js && node /usr/lib/node_modules/@thisisayande/hommies/dist/claude-hook.js || true",
    "claude-hook.js"));
  assert.ok(isHommiesCommand("node /src/agent-fold/packages/omarchy-bridge/dist/claude-hook.js", "claude-hook.js"));
  assert.ok(isHommiesCommand("hommies-claude-hook", "claude-hook.js"));
  assert.ok(isHommiesCommand("agent-fold-claude-hook", "claude-hook.js"), "the bin name from before the rename");
  assert.ok(!isHommiesCommand("node /other/tool/claude-hook.js", "claude-hook.js"));
  assert.ok(!isHommiesCommand("node /opt/hommies/dist/codex-hook.js", "claude-hook.js"));
});

test("Claude hooks merge beside the user's own hooks and replace stale entries", () => {
  const userStop = { hooks: [{ type: "command", command: "say done" }] };
  const settings = {
    model: "opus",
    hooks: {
      Stop: [userStop, { hooks: [{ type: "command", command: "node /old/agent-fold/dist/claude-hook.js", timeout: 5 }] }],
    },
  };
  const next = mergeClaudeSettings(settings, "node /new/hommies/dist/claude-hook.js");
  assert.equal(next.model, "opus");
  assert.deepEqual(next.hooks.Stop, [userStop, { hooks: [{ type: "command", command: "node /new/hommies/dist/claude-hook.js", timeout: 5 }] }]);
  assert.deepEqual(next.hooks.PreToolUse, [{ matcher: "*", hooks: [{ type: "command", command: "node /new/hommies/dist/claude-hook.js" }] }]);
  assert.deepEqual(next.hooks.PostToolUse, [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node /new/hommies/dist/claude-hook.js" }] }]);
  assert.equal(next.hooks.SessionStart[0].hooks[0].timeout, 5);
  assert.equal(next.hooks.StopFailure[0].hooks[0].timeout, 5);
  assert.equal(next.hooks.PermissionRequest[0].hooks[0].timeout, 305);
  assert.deepEqual(mergeClaudeSettings(next, "node /new/hommies/dist/claude-hook.js"), next, "setup is idempotent");
  assert.deepEqual(mergeClaudeSettings(next, null), { model: "opus", hooks: { Stop: [userStop] } });
});

test("uninstall leaves configs without our entries untouched", () => {
  const settings = { hooks: {} };
  assert.equal(mergeClaudeSettings(settings, null), settings);
  const openCode = { plugin: [] };
  assert.equal(mergeOpenCodeConfig(openCode, {}), openCode);
});

test("OpenCode keeps other plugins and swaps our entry", () => {
  const config = { plugin: ["opencode-foo", "file:///old/@agent-fold/bridge/dist/opencode-plugin.js"] };
  assert.deepEqual(mergeOpenCodeConfig(config, { plugin: "file:///opt/hommies/dist/opencode-plugin.js" }).plugin,
    ["opencode-foo", "file:///opt/hommies/dist/opencode-plugin.js"]);
  assert.deepEqual(mergeOpenCodeConfig(config, {}), { plugin: ["opencode-foo"] });
});

test("OpenCode V2 gets a plugin directory under plugins, replacing our V1 file entry", () => {
  const config = { plugin: ["opencode-foo", "file:///old/hommies/dist/opencode-plugin.js"], plugins: ["./my-plugin"] };
  assert.deepEqual(mergeOpenCodeConfig(config, { plugins: "file:///opt/hommies/dist/opencode-v2" }),
    { plugin: ["opencode-foo"], plugins: ["./my-plugin", "file:///opt/hommies/dist/opencode-v2"] });
  // Downgrading swaps it back.
  const v2 = { plugins: ["file:///opt/hommies/dist/opencode-v2"] };
  assert.deepEqual(mergeOpenCodeConfig(v2, { plugin: "file:///opt/hommies/dist/opencode-plugin.js" }),
    { plugin: ["file:///opt/hommies/dist/opencode-plugin.js"] });
  assert.deepEqual(mergeOpenCodeConfig(v2, {}), {});
});

test("setup registers the OpenCode V2 plugin when OpenCode 2 is installed, and checks it without asking OpenCode", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    const file = join(home, ".config", "opencode", "opencode.json");
    await writeFile(file, JSON.stringify({ plugin: ["file:///old/hommies/dist/opencode-plugin.js"] }));
    const v2 = { ...environment, openCodeMajors: async () => [2] };
    const only = { ...install, providers: ["opencode"] };

    assert.deepEqual((await runSetup(only, v2)).map((result) => result.status), ["updated"]);
    assert.deepEqual(await readJson(file), { plugins: ["file:///opt/hommies/dist/opencode-v2"] });
    assert.deepEqual((await runSetup(only, v2)).map((result) => result.status), ["unchanged"]);
    // Without a version (OpenCode not on PATH), the configured flavor is kept.
    assert.deepEqual((await runSetup(only, environment)).map((result) => result.status), ["unchanged"]);
    assert.deepEqual((await checkHooks(environment, ["opencode"])).map((check) => check.status), ["current"]);

    await runSetup({ ...only, uninstall: true }, v2);
    assert.deepEqual(await readJson(file), {});
    assert.deepEqual((await checkHooks(environment, ["opencode"])).map((check) => check.status), ["missing"]);
  });
});

test("every OpenCode on PATH is asked, so a 1.x hidden behind a 2.x still counts", async () => {
  await withHome(async ({ home }) => {
    const bin = async (dir, name, output) => {
      await mkdir(join(home, dir), { recursive: true });
      await writeFile(join(home, dir, name), `#!/bin/sh\necho '${output}'\n`);
      await chmod(join(home, dir, name), 0o755);
    };
    await bin("npm", "opencode", "opencode v2.0.24");
    await bin("npm", "opencode2", "opencode v2.0.24");
    await bin("pacman", "opencode", "1.18.29");
    // A shim of a tool that is not OpenCode, printing its own version.
    await bin("shims", "opencode", "2026.10.1 linux-x64");
    const PATH = ["npm", "shims", "pacman"].map((dir) => join(home, dir)).join(":");
    assert.deepEqual(await detectOpenCodeMajors({ PATH }), [1, 2]);
    assert.deepEqual(await detectOpenCodeMajors({ PATH: join(home, "shims") }), []);
    assert.deepEqual(await detectOpenCodeMajors({}), []);
  });
});

test("with OpenCode 1.x and 2.x both installed, setup registers both plugins", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    const file = join(home, ".config", "opencode", "opencode.json");
    await writeFile(file, JSON.stringify({ plugin: ["opencode-foo", "file:///old/hommies/dist/opencode-plugin.js"] }));
    const both = { ...environment, openCodeMajors: async () => [1, 2] };
    const only = { ...install, providers: ["opencode"] };

    assert.deepEqual((await runSetup(only, both)).map((result) => result.status), ["updated"]);
    assert.deepEqual(await readJson(file), {
      plugin: ["opencode-foo", "file:///opt/hommies/dist/opencode-plugin.js"],
      plugins: ["file:///opt/hommies/dist/opencode-v2"],
    });
    assert.deepEqual((await runSetup(only, both)).map((result) => result.status), ["unchanged"]);
    assert.deepEqual((await checkHooks(environment, ["opencode"])).map((check) => check.status), ["current"]);

    // Removing 1.x later drops the V1 entry on the next setup.
    await runSetup(only, { ...environment, openCodeMajors: async () => [2] });
    assert.deepEqual(await readJson(file), { plugin: ["opencode-foo"], plugins: ["file:///opt/hommies/dist/opencode-v2"] });
  });
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
      "test -f /opt/hommies/dist/claude-hook.js && node /opt/hommies/dist/claude-hook.js || true");
    assert.deepEqual(written.hooks.SubagentStart, [{ hooks: [{ type: "command", command: written.hooks.Stop[0].hooks[0].command, timeout: 5 }] }]);
    assert.ok(written.hooks.SubagentStop, "subagent steps need both events");
    assert.deepEqual((await readJson(join(home, ".config", "opencode", "opencode.json"))).plugin,
      ["file:///opt/hommies/dist/opencode-plugin.js"]);

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
    assert.deepEqual(hooks.PermissionRequest, [{ matcher: "*", hooks: [{ type: "command", command: "test -f /opt/hommies/dist/codex-hook.js && node /opt/hommies/dist/codex-hook.js || true", timeout: 305 }] }]);
  });
});

test("setup writes a hommies-bridge launcher in ~/.local/bin and uninstall removes only its own", async () => {
  await withHome(async ({ home }) => {
    const dist = join(home, "nvm", "lib", "node_modules", "@thisisayande", "hommies", "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "runtime.js"), "");
    const environment = { home, env: {}, distDir: dist, nodePath: "/opt/node 24/bin/node" };
    const launcher = join(home, ".local", "bin", "hommies-bridge");
    const run = (uninstall) => linkBridgeCommand({ uninstall, dryRun: false }, environment);

    assert.equal((await run(false)).status, "updated");
    const text = await readFile(launcher, "utf8");
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.ok(text.includes(`exec '/opt/node 24/bin/node' ${join(dist, "runtime.js")} "$@"`), "absolute node, quoted");
    assert.equal((await lstat(launcher)).mode & 0o777, 0o755);
    assert.equal((await run(false)).status, "unchanged");

    // A link from an older install, even dangling, is replaced.
    await rm(launcher);
    await symlink(join(home, "gone", "hommies", "dist", "runtime.js"), launcher);
    assert.equal((await run(false)).status, "updated");
    assert.ok((await lstat(launcher)).isFile());

    assert.equal((await run(true)).status, "updated");
    assert.equal(await lstat(launcher).catch(() => null), null);

    // The user's own file or link is never touched.
    await writeFile(launcher, "#!/bin/sh\n");
    assert.equal((await run(false)).status, "skipped");
    assert.equal((await run(true)).status, "skipped");
    assert.equal(await readFile(launcher, "utf8"), "#!/bin/sh\n");
    await rm(launcher);
    await symlink("/opt/elsewhere/bridge", launcher);
    assert.equal((await run(false)).status, "skipped");
    assert.equal(await readlink(launcher), "/opt/elsewhere/bridge");
  });
});
