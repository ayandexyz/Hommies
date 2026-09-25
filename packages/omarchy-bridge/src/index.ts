/**
 * @agent-fold/bridge public API.
 *
 * The QML plugin only consumes `startBridgeServer`. Everything else is re-exported
 * here so future callers (CLI, dev tooling) can use the same primitives.
 */

export { startBridgeServer } from "./server.ts";
export type { BridgeServerOptions, PendingItem, PendingResponse } from "./types.ts";