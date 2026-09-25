import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeServerOptions, PendingResponse, PendingResponseInput } from "./types.ts";

/**
 * Boot the localhost HTTP server.
 *
 * v0 scaffold: returns without binding. The real implementation will:
 *   1. Initialise the SQLite database under `options.dataDir` with the same
 *      schema migrations as `apps/server/src/persistence/Migrations/`.
 *   2. Compose the Effect layer: ProjectionPipeline + ProviderService + the
 *      six provider adapters + OrchestrationEngine.
 *   3. Mount an HTTP server on `127.0.0.1:options.port` with the four routes.
 *   4. Write the chosen port to `dataDir/port.json` so `bridge.mjs` can find it.
 *
 * Until then, this throws — we want the QML plugin to surface a clear error
 * rather than silently bind a half-implemented server.
 */
export async function startBridgeServer(
  options: BridgeServerOptions,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const portFile = join(options.dataDir, "port.json");
  await writeFile(
    portFile,
    JSON.stringify({ implemented: false, requested: options }, null, 2),
    "utf8",
  );
  throw new Error(
    `agent-fold bridge: startBridgeServer is not yet implemented (dataDir=${options.dataDir}). ` +
      `See packages/omarchy-bridge/README.md.`,
  );
}

/**
 * Hand-rolled shape for the four HTTP routes. Defined here so the QML plugin
 * can be typechecked against the same contract once we implement the server.
 * Not exported from index.ts — internal.
 */
export interface BridgeRouteHandlers {
  readonly handlePending: () => Promise<PendingResponse>;
  readonly handleRespond: (input: PendingResponseInput) => Promise<{ readonly ok: true }>;
  readonly handleHealth: () => Promise<{ readonly ok: true }>;
  readonly handleStreamSubscribe: () => AsyncIterable<PendingResponse>;
}