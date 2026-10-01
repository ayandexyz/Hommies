#!/usr/bin/env node
/** `agent-fold` CLI: registers or removes the agent hooks that report to the bridge. */
import { defaultSetupEnvironment, runSetup, SETUP_PROVIDERS, type SetupProvider, type SetupResult } from "./setup.js";

const USAGE = `Usage: agent-fold <command> [options]

Commands:
  setup       Register agent-fold hooks for Claude Code, Codex, and OpenCode
  uninstall   Remove the hooks that setup added

Options:
  --dry-run          Show what would change without writing anything
  --only <list>      Comma-separated providers: ${SETUP_PROVIDERS.join(",")}
  -h, --help         Show this help

Each changed config is backed up next to itself as <file>.agent-fold-backup-<time>.`;

const isProvider = (value: string): value is SetupProvider => (SETUP_PROVIDERS as ReadonlyArray<string>).includes(value);

function fail(message: string): never {
  process.stderr.write(`agent-fold: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function report(results: ReadonlyArray<SetupResult>, uninstall: boolean): void {
  for (const result of results) {
    const mark = { updated: "✓", unchanged: "=", skipped: "-", error: "✗" }[result.status];
    process.stdout.write(`${mark} ${result.provider.padEnd(8)} ${result.message} (${result.file})\n`);
    if (result.backup !== undefined) process.stdout.write(`             backup: ${result.backup}\n`);
  }
  if (uninstall) return;
  const updated = new Set(results.filter((result) => result.status === "updated").map((result) => result.provider));
  if (updated.has("codex")) process.stdout.write("\nCodex: review and trust the new hooks from Codex's /hooks screen.\n");
  if (updated.has("opencode")) process.stdout.write("OpenCode: restart OpenCode to load the plugin.\n");
  if (updated.size > 0) process.stdout.write("Omacode needs no setup; its integration is built in.\n");
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
  let providers: ReadonlyArray<SetupProvider> = SETUP_PROVIDERS;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--only") {
      const list = (rest[++i] ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
      const unknown = list.filter((value) => !isProvider(value));
      if (list.length === 0 || unknown.length > 0) fail(`--only expects ${SETUP_PROVIDERS.join(", ")}`);
      providers = list.filter(isProvider);
    } else fail(`unknown option '${arg ?? ""}'`);
  }

  const uninstall = command === "uninstall";
  const results = await runSetup({ uninstall, dryRun, providers }, defaultSetupEnvironment());
  report(results, uninstall);
  if (results.some((result) => result.status === "error")) process.exitCode = 1;
}

void main();
