/**
 * @thisisayande/agent-fold public API.
 *
 * The QML plugin only consumes `startBridgeServer`. Everything else is re-exported
 * here so future callers (CLI, dev tooling) can use the same primitives.
 */

export { startBridgeServer } from "./server.js";
export { createDesktopNotifier } from "./notifier.js";
export type { BridgeNotification, BridgeNotifier } from "./notifier.js";
export type { BridgeServerOptions, PendingItem, PendingResponse, SessionActivity, SessionActivityState, SessionFailureKind } from "./types.js";
