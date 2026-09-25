/**
 * agent-fold bridge client.
 *
 * Loaded by QML via `import "bridge.mjs" as Bridge`. The QML files call
 * `Bridge.snapshot()`, `Bridge.subscribe()`, and `Bridge.respond()`.
 *
 * v0 scaffold: every method returns empty data / resolves immediately.
 * The real implementation will:
 *   1. Read `<dataDir>/port.json` to find the bridge daemon's port.
 *   2. Fetch `GET /v1/pending` and decode the JSON.
 *   3. Open an `EventSource` against `GET /v1/stream` for live updates.
 *   4. POST `POST /v1/respond` to dispatch user answers.
 *
 * The daemon is owned by Service.qml (a separate Quickshell service kind);
 * this module only consumes it.
 */

const empty = () => ({
  totalCount: 0,
  threads: [],
});

export async function snapshot() {
  return empty();
}

/**
 * Subscribe to live updates. Returns an unsubscribe function.
 *
 * The QML side does not currently call this — the BarWidget polls
 * `snapshot()` every 3s. SSE wiring is v2.
 */
export function subscribe(_onUpdate) {
  return () => {};
}

export async function respond(_input) {
  return { ok: true };
}