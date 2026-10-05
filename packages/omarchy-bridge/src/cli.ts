#!/usr/bin/env node
/** `hommies` CLI (`agent-fold` is the alias from before the rename): registers or removes the agent hooks that report to the bridge. */
import { multiselect, type Choice } from "./multiselect.js";
import {
  checkHooks, defaultSetupEnvironment, runSetup, SETUP_PROVIDERS, type HookCheck, type SetupProvider, type SetupResult,
} from "./setup.js";

const USAGE = `Usage: hommies <command> [options]

Commands:
  setup       Register hooks for Claude Code, Codex, and OpenCode. In a
              terminal it lists the agents it found and lets you pick.
  uninstall   Remove the hooks that setup added

Options:
  --dry-run          Show what would change without writing anything
  --check            Report whether each agent's hooks are current; exits 1
                     when any are out of date (setup only)
  --only <list>      Comma-separated providers: ${SETUP_PROVIDERS.join(",")}
  -y, --yes          Set up every installed agent without asking
  -h, --help         Show this help

Each changed config is backed up next to itself as <file>.hommies-backup-<time>.`;

const isProvider = (value: string): value is SetupProvider => (SETUP_PROVIDERS as ReadonlyArray<string>).includes(value);

function fail(message: string): never {
  process.stderr.write(`hommies: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function report(results: ReadonlyArray<SetupResult>, uninstall: boolean): void {
  for (const result of results) {
    const mark = { updated: "✓", unchanged: "=", skipped: "-", error: "✗" }[result.status];
    process.stdout.write(`${mark} ${result.provider.padEnd(11)} ${result.message} (${result.file})\n`);
    if (result.backup !== undefined) process.stdout.write(`              backup: ${result.backup}\n`);
  }
  if (uninstall) return;
  const updated = new Set(results.filter((result) => result.status === "updated").map((result) => result.provider));
  if (updated.has("codex")) process.stdout.write("\nCodex: review and trust the new hooks from Codex's /hooks screen.\n");
  if (updated.has("opencode")) process.stdout.write("OpenCode: restart OpenCode to load the plugin.\n");
  if (updated.has("gemini")) process.stdout.write("Gemini CLI: restart it, and approve the new hooks if it asks.\n");
  if (updated.has("antigravity")) process.stdout.write("Antigravity: restart agy to load the hooks.\n");
  if (updated.has("grok")) process.stdout.write("Grok Build: restart grok to load the hooks.\n");
  if (updated.size > 0) process.stdout.write("Omacode needs no setup; its integration is built in.\n");
}

const checkLines: Record<HookCheck["status"], string> = {
  current: "✓ hooks are up to date",
  outdated: "! hooks are out of date; run `hommies setup`",
  missing: "- no Hommies hooks; run `hommies setup` to add them",
  "not-installed": "- not installed",
  unsupported: "- JSONC config; check it by hand (see README)",
  error: "✗ config could not be read",
};

const providerLabels: Record<SetupProvider, string> = {
  claude: "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI", antigravity: "Antigravity", grok: "Grok Build",
};

const pickHints: Record<HookCheck["status"], string> = {
  current: "hooks up to date",
  outdated: "hooks out of date",
  missing: "found",
  "not-installed": "not installed",
  unsupported: "JSONC config; edit it by hand (see README)",
  error: "config could not be read",
};

/** Asks which installed agents to set up. Returns `null` when the user cancels. */
async function pickProviders(): Promise<SetupProvider[] | null> {
  const checks = await checkHooks(defaultSetupEnvironment());
  const choices: Choice<SetupProvider>[] = checks.map((check) => {
    const usable = check.status !== "not-installed" && check.status !== "unsupported";
    return { value: check.provider, label: providerLabels[check.provider], hint: pickHints[check.status], checked: usable, disabled: !usable };
  });
  if (!choices.some((choice) => choice.disabled !== true)) {
    process.stdout.write("No supported agents found (Claude Code, Codex, OpenCode).\n");
    return [];
  }
  return multiselect("Which agents should report to the Omarchy bar?", choices);
}

function reportChecks(checks: ReadonlyArray<HookCheck>): void {
  for (const check of checks) {
    const [mark, ...words] = checkLines[check.status].split(" ");
    process.stdout.write(`${mark} ${check.provider.padEnd(11)} ${words.join(" ")} (${check.file})\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [command, ...rest] = args;
  if (command !== "setup" && command !== "uninstall") fail(`unknown command '${command ?? ""}'`);

  let dryRun = false;
  let check = false;
  let yes = false;
  let only = false;
  let providers: ReadonlyArray<SetupProvider> = SETUP_PROVIDERS;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check" && command === "setup") check = true;
    else if (arg === "-y" || arg === "--yes") yes = true;
    else if (arg === "--only") {
      const list = (rest[++i] ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
      const unknown = list.filter((value) => !isProvider(value));
      if (list.length === 0 || unknown.length > 0) fail(`--only expects ${SETUP_PROVIDERS.join(", ")}`);
      providers = list.filter(isProvider);
      only = true;
    } else fail(`unknown option '${arg ?? ""}'`);
  }

  if (check) {
    const checks = await checkHooks(defaultSetupEnvironment(), providers);
    reportChecks(checks);
    if (checks.some((entry) => entry.status === "outdated" || entry.status === "error")) process.exitCode = 1;
    return;
  }

  const uninstall = command === "uninstall";
  if (!uninstall && !only && !yes && process.stdin.isTTY && process.stdout.isTTY) {
    const picked = await pickProviders();
    if (picked === null) {
      process.stdout.write("Cancelled; nothing changed.\n");
      return;
    }
    if (picked.length === 0) return;
    providers = picked;
  }
  const results = await runSetup({ uninstall, dryRun, providers }, defaultSetupEnvironment());
  report(results, uninstall);
  if (results.some((result) => result.status === "error")) process.exitCode = 1;
}

void main();
