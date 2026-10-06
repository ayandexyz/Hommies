/**
 * Registers (or removes) the Hommies hooks in each agent's own config:
 * Claude Code `settings.json`, Codex `hooks.json`, OpenCode `opencode.json`,
 * Gemini CLI `settings.json`, Antigravity `hooks.json`, and a Grok Build hook file.
 *
 * Merges never drop the user's other hooks or plugins. An entry belongs to
 * Hommies when its command runs one of our hook files, so re-running setup
 * replaces stale paths instead of duplicating them, and uninstall removes only
 * what setup added. Every changed file is backed up and replaced atomically.
 */
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type SetupProvider = "claude" | "codex" | "opencode" | "gemini" | "antigravity" | "grok";
export const SETUP_PROVIDERS: ReadonlyArray<SetupProvider> = ["claude", "codex", "opencode", "gemini", "antigravity", "grok"];

type JsonObject = { [key: string]: unknown };

interface HookSpec {
  readonly event: string;
  readonly matcher?: string;
  readonly timeout?: number;
  /** Extra arguments for this entry's command (see `mergeCommandHooks`'s `commandWithArgs`). */
  readonly args?: ReadonlyArray<string>;
}

/**
 * `PreToolUse` and `PostToolUseFailure` match every tool: the hook blocks only
 * for AskUserQuestion and reports every other tool call as live activity.
 * The AskUserQuestion PreToolUse hook has no timeout because it waits for the bar.
 */
const CLAUDE_HOOKS: ReadonlyArray<HookSpec> = [
  { event: "SessionStart", timeout: 5 },
  { event: "PreToolUse", matcher: "*" },
  { event: "PostToolUse", matcher: "AskUserQuestion" },
  { event: "PostToolUseFailure", matcher: "*", timeout: 5 },
  { event: "PermissionRequest", timeout: 305 },
  { event: "Stop", timeout: 5 },
  { event: "StopFailure", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "SessionEnd", timeout: 5 },
  { event: "SubagentStart", timeout: 5 },
  { event: "SubagentStop", timeout: 5 },
];

/** Codex has no StopFailure hook, so its failed turns are not reported. */
const CODEX_HOOKS: ReadonlyArray<HookSpec> = [
  { event: "SessionStart", timeout: 5 },
  { event: "PreToolUse", matcher: "*", timeout: 5 },
  { event: "PermissionRequest", matcher: "*", timeout: 305 },
  { event: "Stop", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "SessionEnd", timeout: 5 },
];

/**
 * Gemini CLI timeouts are in milliseconds. `AfterTool` and the model events
 * are left out: one step per tool call is enough, and `AfterModel` fires on
 * every streamed chunk.
 */
const GEMINI_HOOKS: ReadonlyArray<HookSpec> = [
  { event: "SessionStart", timeout: 5000 },
  { event: "BeforeTool", matcher: "*", timeout: 5000 },
  { event: "BeforeAgent", timeout: 5000 },
  { event: "AfterAgent", timeout: 5000 },
  { event: "SessionEnd", timeout: 5000 },
];

/**
 * Grok Build uses Claude's event names; a missing matcher matches every tool.
 * `StopCancelled` runs instead of `Stop` when a turn is interrupted. The
 * `ask_user_question` entry waits up to 5 minutes for an answer from the bar.
 */
const GROK_HOOKS: ReadonlyArray<HookSpec> = [
  { event: "SessionStart", timeout: 5 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "PreToolUse", timeout: 5 },
  { event: "PreToolUse", matcher: "^ask_user_question$", timeout: 305, args: ["question"] },
  { event: "PostToolUseFailure", timeout: 5 },
  { event: "Stop", timeout: 5 },
  { event: "StopFailure", timeout: 5 },
  { event: "StopCancelled", timeout: 5 },
  { event: "SessionEnd", timeout: 5 },
];

/** The key our entry lives under in Antigravity's `hooks.json`, which is keyed by hook name. */
const ANTIGRAVITY_HOOK_NAME = "hommies";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_\/.@+:=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Runs the hook only while its file exists, and never reports failure. If the
 * package is removed without `uninstall`, the leftover hooks do nothing instead
 * of erroring on every agent event. The hooks never signal through exit codes.
 */
export const hookCommand = (hookPath: string, ...args: string[]): string => {
  const path = shellQuote(hookPath);
  const rest = args.map((arg) => ` ${shellQuote(arg)}`).join("");
  return `test -f ${path} && node ${path}${rest} || true`;
};

/**
 * For agents that read a JSON object from every hook's stdout (Gemini CLI,
 * Antigravity): the hook prints `{}` itself, and a removed package prints it here.
 */
export const jsonHookCommand = (hookPath: string, ...args: string[]): string => {
  const path = shellQuote(hookPath);
  const rest = args.map((arg) => ` ${shellQuote(arg)}`).join("");
  return `test -f ${path} && node ${path}${rest} || echo '{}'`;
};

/** Install paths that belong to us: the current package, its old name, and a source checkout. */
const OUR_PATH = /hommies|agent-fold|omarchy-bridge/;

/**
 * True for a command that runs our `hookFile` (any install location), under
 * the `hommies-*` bin names or the `agent-fold-*` ones from before the rename.
 */
export function isHommiesCommand(command: unknown, hookFile: string): boolean {
  if (typeof command !== "string") return false;
  const hook = hookFile.replace(/\.js$/, "");
  if (new RegExp(`(^|[\\s/'"])(hommies|agent-fold)-${hook}(['"\\s]|$)`).test(command)) return true;
  return command.includes(`/${hookFile}`) && OUR_PATH.test(command);
}

/**
 * Returns a copy of a `{ hooks: { Event: [group] } }` config with our
 * hook entries removed and, when `command` is given, re-added once per spec.
 */
export function mergeCommandHooks(
  config: JsonObject,
  specs: ReadonlyArray<HookSpec>,
  hookFile: string,
  command: string | null,
  /** The command for a spec with `args`; required when any spec has them. */
  commandWithArgs?: (args: ReadonlyArray<string>) => string,
): JsonObject {
  const next: JsonObject = { ...config };
  const hooks: JsonObject = isObject(config.hooks) ? { ...config.hooks } : {};
  const ours = (entry: unknown): boolean => isObject(entry) && isHommiesCommand(entry.command, hookFile);
  let removed = false;

  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap((group: unknown) => {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(ours)) return [group];
      removed = true;
      const rest = group.hooks.filter((entry: unknown) => !ours(entry));
      return rest.length === 0 ? [] : [{ ...group, hooks: rest }];
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  if (command === null && !removed) return config;
  if (command !== null) {
    for (const spec of specs) {
      const entry: JsonObject = { type: "command", command: spec.args && commandWithArgs ? commandWithArgs(spec.args) : command };
      if (spec.timeout !== undefined) entry.timeout = spec.timeout;
      const group: JsonObject = spec.matcher === undefined ? { hooks: [entry] } : { matcher: spec.matcher, hooks: [entry] };
      const groups = hooks[spec.event];
      hooks[spec.event] = Array.isArray(groups) ? [...groups, group] : [group];
    }
  }

  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

/**
 * Our own entries in a command-hook config, one sorted line per
 * entry. Two configs with the same lines have the same Hommies hooks,
 * whatever the order of the user's other hooks.
 */
export function commandHookFingerprint(config: JsonObject, hookFile: string): string[] {
  const hooks = isObject(config.hooks) ? config.hooks : {};
  const lines: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const entry of group.hooks) {
        if (!isObject(entry) || !isHommiesCommand(entry.command, hookFile)) continue;
        lines.push(JSON.stringify([event, group.matcher ?? null, entry.command, entry.timeout ?? null]));
      }
    }
  }
  return lines.sort();
}

export function openCodeFingerprint(config: JsonObject): string[] {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return plugins
    .filter((entry: unknown): entry is string =>
      typeof entry === "string" && entry.endsWith("/opencode-plugin.js") && OUR_PATH.test(entry))
    .sort();
}

export const mergeClaudeSettings = (config: JsonObject, command: string | null): JsonObject =>
  mergeCommandHooks(config, CLAUDE_HOOKS, "claude-hook.js", command);

export const mergeCodexHooks = (config: JsonObject, command: string | null): JsonObject =>
  mergeCommandHooks(config, CODEX_HOOKS, "codex-hook.js", command);

export const mergeGeminiSettings = (config: JsonObject, command: string | null): JsonObject =>
  mergeCommandHooks(config, GEMINI_HOOKS, "gemini-hook.js", command);

export const mergeGrokHooks = (config: JsonObject, hookPath: string | null): JsonObject =>
  mergeCommandHooks(config, GROK_HOOKS, "grok-hook.js", hookPath === null ? null : hookCommand(hookPath),
    (args) => hookCommand(hookPath ?? "", ...args));

/**
 * Antigravity's `hooks.json` maps hook names to their events. We own the
 * `hommies` entry: it is replaced on install and removed on uninstall, and
 * the user's other entries are kept. Antigravity sends no event name, so each
 * command passes it as an argument. `PreToolUse` is hooked for `ask_question`
 * only, since for other tools its answer is a permission decision.
 */
export function mergeAntigravityHooks(config: JsonObject, hookPath: string | null): JsonObject {
  if (hookPath === null && !(ANTIGRAVITY_HOOK_NAME in config)) return config;
  const next: JsonObject = { ...config };
  delete next[ANTIGRAVITY_HOOK_NAME];
  if (hookPath !== null) {
    const handler = (event: string, timeout = 5): JsonObject => ({ type: "command", command: jsonHookCommand(hookPath, event), timeout });
    next[ANTIGRAVITY_HOOK_NAME] = {
      enabled: true,
      // Only ask_question: the hook allows it and mirrors the question in the bar.
      // Waits up to 5 minutes for an answer from the bar (timeouts are in seconds).
      PreToolUse: [{ matcher: "^ask_question$", hooks: [handler("PreToolUse", 305)] }],
      PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
      Stop: [handler("Stop")],
    };
  }
  return next;
}

export const antigravityFingerprint = (config: JsonObject): string[] =>
  ANTIGRAVITY_HOOK_NAME in config ? [JSON.stringify(config[ANTIGRAVITY_HOOK_NAME])] : [];

/** Returns a copy of an OpenCode config with our plugin entry replaced (or removed when `pluginUrl` is null). */
export function mergeOpenCodeConfig(config: JsonObject, pluginUrl: string | null): JsonObject {
  const next: JsonObject = { ...config };
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const kept = plugins.filter((entry: unknown) =>
    !(typeof entry === "string" && entry.endsWith("/opencode-plugin.js") && OUR_PATH.test(entry)));
  if (pluginUrl === null && kept.length === plugins.length) return config;
  if (pluginUrl !== null) kept.push(pluginUrl);
  if (kept.length === 0) delete next.plugin;
  else next.plugin = kept;
  return next;
}

export interface SetupEnvironment {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory holding the compiled hook files; defaults to this module's directory. */
  readonly distDir?: string;
}

export interface SetupOptions {
  readonly uninstall: boolean;
  readonly dryRun: boolean;
  readonly providers: ReadonlyArray<SetupProvider>;
}

export type SetupStatus = "updated" | "unchanged" | "skipped" | "error";

export interface SetupResult {
  readonly provider: SetupProvider;
  readonly status: SetupStatus;
  readonly file: string;
  readonly message: string;
  readonly backup?: string;
}

interface ProviderTarget {
  readonly provider: SetupProvider;
  /** The agent's config directory; its absence means the agent is not installed. */
  readonly configDir: string;
  readonly file: string;
  readonly merge: (config: JsonObject, install: boolean) => JsonObject;
  /** Our entries in a config; see `commandHookFingerprint`. */
  readonly fingerprint: (config: JsonObject) => string[];
  /** Config variants setup cannot edit safely; when one exists the provider is skipped. */
  readonly unsupported?: string;
}

function targets(environment: SetupEnvironment): ReadonlyArray<ProviderTarget> {
  const { home, env } = environment;
  const distDir = environment.distDir ?? dirname(fileURLToPath(import.meta.url));
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexDir = env.CODEX_HOME || join(home, ".codex");
  const openCodeDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const geminiDir = join(home, ".gemini");
  const antigravityDir = join(geminiDir, "config");
  const grokDir = join(home, ".grok");
  return [
    {
      provider: "claude",
      configDir: claudeDir,
      file: join(claudeDir, "settings.json"),
      merge: (config, install) => mergeClaudeSettings(config, install ? hookCommand(join(distDir, "claude-hook.js")) : null),
      fingerprint: (config) => commandHookFingerprint(config, "claude-hook.js"),
    },
    {
      provider: "codex",
      configDir: codexDir,
      file: join(codexDir, "hooks.json"),
      merge: (config, install) => mergeCodexHooks(config, install ? hookCommand(join(distDir, "codex-hook.js")) : null),
      fingerprint: (config) => commandHookFingerprint(config, "codex-hook.js"),
    },
    {
      provider: "opencode",
      configDir: openCodeDir,
      file: join(openCodeDir, "opencode.json"),
      unsupported: join(openCodeDir, "opencode.jsonc"),
      merge: (config, install) =>
        mergeOpenCodeConfig(config, install ? pathToFileURL(join(distDir, "opencode-plugin.js")).href : null),
      fingerprint: openCodeFingerprint,
    },
    {
      provider: "gemini",
      configDir: geminiDir,
      file: join(geminiDir, "settings.json"),
      merge: (config, install) => mergeGeminiSettings(config, install ? jsonHookCommand(join(distDir, "gemini-hook.js")) : null),
      fingerprint: (config) => commandHookFingerprint(config, "gemini-hook.js"),
    },
    {
      provider: "antigravity",
      configDir: antigravityDir,
      file: join(antigravityDir, "hooks.json"),
      merge: (config, install) => mergeAntigravityHooks(config, install ? join(distDir, "antigravity-hook.js") : null),
      fingerprint: antigravityFingerprint,
    },
    {
      // A hook file of our own, so the user's other Grok hook files are never touched.
      provider: "grok",
      configDir: grokDir,
      file: join(grokDir, "hooks", "hommies.json"),
      merge: (config, install) => mergeGrokHooks(config, install ? join(distDir, "grok-hook.js") : null),
      fingerprint: (config) => commandHookFingerprint(config, "grok-hook.js"),
    },
  ];
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

async function readConfig(path: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error("top-level value is not a JSON object");
  return parsed;
}

/** Writes through symlinks (dotfile managers) via a private sibling file and an atomic rename. */
async function writeConfig(path: string, config: JsonObject, backupSuffix: string): Promise<string | undefined> {
  const target = await realpath(path).catch(() => path);
  await mkdir(dirname(target), { recursive: true });
  const previous = await stat(target).catch(() => null);
  let backup: string | undefined;
  if (previous !== null) {
    backup = `${target}.hommies-backup-${backupSuffix}`;
    await copyFile(target, backup);
  }
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: previous?.mode ?? 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return backup;
}

export async function runSetup(options: SetupOptions, environment: SetupEnvironment): Promise<ReadonlyArray<SetupResult>> {
  const backupSuffix = new Date().toISOString().replace(/[:.]/g, "-");
  const results: SetupResult[] = [];
  for (const target of targets(environment)) {
    if (!options.providers.includes(target.provider)) continue;
    const { provider, file } = target;
    if (!(await exists(target.configDir))) {
      results.push({ provider, file: target.configDir, status: "skipped", message: "not installed" });
      continue;
    }
    if (target.unsupported !== undefined && (await exists(target.unsupported))) {
      results.push({ provider, file: target.unsupported, status: "skipped", message: "JSONC config; edit it by hand (see README)" });
      continue;
    }
    try {
      const current = await readConfig(file);
      if (current === null && options.uninstall) {
        results.push({ provider, file, status: "unchanged", message: "no config file" });
        continue;
      }
      const before = current ?? {};
      const after = target.merge(before, !options.uninstall);
      if (current !== null && JSON.stringify(before) === JSON.stringify(after)) {
        results.push({ provider, file, status: "unchanged", message: "already up to date" });
        continue;
      }
      const verb = options.uninstall ? "removed Hommies hooks" : "registered Hommies hooks";
      if (options.dryRun) {
        results.push({ provider, file, status: "updated", message: `would have ${verb}` });
        continue;
      }
      const backup = await writeConfig(file, after, backupSuffix);
      results.push({ provider, file, status: "updated", message: verb, ...(backup === undefined ? {} : { backup }) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ provider, file, status: "error", message: `left untouched: ${reason}` });
    }
  }
  return results;
}

/** Marks the launcher as ours, so re-running setup may replace it and uninstall may remove it. */
const LAUNCHER_MARK = "# Written by `hommies setup`";

/**
 * The Omarchy plugin starts `hommies-bridge` from the shell's PATH, which has
 * `~/.local/bin` but neither a version manager's global bin (nvm, fnm, volta)
 * nor, always, `node`. So setup writes a launcher there that runs the bridge
 * with the Node that ran setup. Our launcher, or a link of ours from older
 * installs, is replaced; anything else there is the user's and left alone.
 */
export async function linkBridgeCommand(
  options: Pick<SetupOptions, "uninstall" | "dryRun">,
  environment: SetupEnvironment & { readonly nodePath?: string },
): Promise<{ readonly status: SetupStatus; readonly file: string; readonly message: string }> {
  const distDir = environment.distDir ?? dirname(fileURLToPath(import.meta.url));
  const launcherPath = join(environment.home, ".local", "bin", "hommies-bridge");
  const launcher = `#!/bin/sh\n${LAUNCHER_MARK}; \`hommies uninstall\` removes it.\n` +
    `exec ${shellQuote(environment.nodePath ?? process.execPath)} ${shellQuote(join(distDir, "runtime.js"))} "$@"\n`;
  const existing = await lstat(launcherPath).catch(() => null);
  let current: string | null = null;
  if (existing?.isSymbolicLink() === true) {
    // A dangling link (package removed or moved) is judged by where it points.
    const target = await realpath(launcherPath).catch(() => readlink(launcherPath));
    if (!(OUR_PATH.test(target) && target.endsWith("runtime.js"))) {
      return { status: "skipped", file: launcherPath, message: "left your own link in place" };
    }
  } else if (existing !== null) {
    current = await readFile(launcherPath, "utf8").catch(() => "");
    if (!current.includes(LAUNCHER_MARK)) return { status: "skipped", file: launcherPath, message: "left your own file in place" };
  }
  if (options.uninstall) {
    if (existing === null) return { status: "unchanged", file: launcherPath, message: "no bridge launcher" };
    if (!options.dryRun) await rm(launcherPath, { force: true });
    return { status: "updated", file: launcherPath, message: options.dryRun ? "would have removed the bridge launcher" : "removed the bridge launcher" };
  }
  if (current === launcher) return { status: "unchanged", file: launcherPath, message: "bridge launcher already up to date" };
  if (options.dryRun) return { status: "updated", file: launcherPath, message: "would have written the bridge launcher" };
  await mkdir(dirname(launcherPath), { recursive: true });
  await rm(launcherPath, { force: true });
  await writeFile(launcherPath, launcher, { mode: 0o755 });
  return { status: "updated", file: launcherPath, message: "wrote the bridge launcher for the Omarchy plugin" };
}

/**
 * - `current`: the config has exactly the hooks setup would write
 * - `outdated`: it has Hommies hooks, but not those (missing events, old
 *   paths, edited matchers or timeouts)
 * - `missing`: the agent is installed but has no Hommies hooks
 * - `not-installed`, `unsupported` (OpenCode JSONC), `error` (unreadable config)
 */
export type HookStatus = "current" | "outdated" | "missing" | "not-installed" | "unsupported" | "error";

export interface HookCheck {
  readonly provider: SetupProvider;
  readonly status: HookStatus;
  readonly file: string;
}

/** Compares each agent's config with what `setup` would write. Never writes. */
export async function checkHooks(
  environment: SetupEnvironment,
  providers: ReadonlyArray<SetupProvider> = SETUP_PROVIDERS,
): Promise<ReadonlyArray<HookCheck>> {
  const checks: HookCheck[] = [];
  for (const target of targets(environment)) {
    if (!providers.includes(target.provider)) continue;
    const { provider, file } = target;
    if (!(await exists(target.configDir))) {
      checks.push({ provider, status: "not-installed", file: target.configDir });
      continue;
    }
    if (target.unsupported !== undefined && (await exists(target.unsupported))) {
      checks.push({ provider, status: "unsupported", file: target.unsupported });
      continue;
    }
    try {
      const config = (await readConfig(file)) ?? {};
      const current = target.fingerprint(config);
      const expected = target.fingerprint(target.merge(config, true));
      const status = current.length === 0 ? "missing"
        : JSON.stringify(current) === JSON.stringify(expected) ? "current" : "outdated";
      checks.push({ provider, status, file });
    } catch {
      checks.push({ provider, status: "error", file });
    }
  }
  return checks;
}

/** Providers with Hommies hooks in their config, whether current or outdated. */
export async function connectedHookProviders(environment: SetupEnvironment = defaultSetupEnvironment()): Promise<SetupProvider[]> {
  return (await checkHooks(environment))
    .filter((check) => check.status === "current" || check.status === "outdated")
    .map((check) => check.provider);
}

/** Providers whose Hommies hooks exist but differ from what setup would write. */
export async function outdatedHookProviders(environment: SetupEnvironment = defaultSetupEnvironment()): Promise<SetupProvider[]> {
  return (await checkHooks(environment)).filter((check) => check.status === "outdated").map((check) => check.provider);
}

export const defaultSetupEnvironment = (): SetupEnvironment => ({ home: homedir(), env: process.env });
