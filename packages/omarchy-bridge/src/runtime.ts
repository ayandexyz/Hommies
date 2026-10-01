#!/usr/bin/env node
/**
 * Runtime entry point — invoked by the Omarchy `service`-kind plugin.
 *
 * This module is the CLI shim: it parses argv, ensures `dataDir` exists,
 * and calls `startBridgeServer`. The QML plugin's `bridge.mjs` shells out
 * to `node` with this entry point (or imports a thin HTTP client and dials
 * a port already chosen).
 *
 * v0 scaffold: argv parsing and `dataDir` creation only.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createDesktopNotifier } from "./notifier.js";
import { startBridgeServer } from "./server.js";
import { outdatedHookProviders } from "./setup.js";

interface RuntimeOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly notify: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): RuntimeOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === undefined || !current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }
    args.set(key, next);
    i++;
  }
  return {
    dataDir: resolve(args.get("data-dir") ?? ".bridge-data"),
    port: Number(args.get("port") ?? "0"),
    host: args.get("host") ?? "127.0.0.1",
    notify: args.get("no-notify") !== "true",
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.dataDir, { recursive: true });
  const server = await startBridgeServer({
    dataDir: options.dataDir,
    port: options.port,
    host: options.host,
    ...(options.notify ? { notify: createDesktopNotifier() } : {}),
    checkHooks: () => outdatedHookProviders(),
  });
  process.stdout.write(`agent-fold-bridge listening on ${options.host}:${server.port}\n`);
  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`agent-fold-bridge failed: ${String(error)}\n`);
  process.exit(1);
});
