import type { ApprovalRequestId, ProviderDriverKind, ThreadId } from "./localContracts.ts";

/**
 * Options for `startBridgeServer`.
 *
 * `dataDir` is the on-disk location for the SQLite database, the projection
 * journal, and `port.json`. The bridge writes a single `port.json` file under
 * `dataDir` so the QML plugin can discover the chosen port without env vars.
 *
 * `port: 0` asks the OS for a free port — the bridge always does this in
 * production. Explicit ports are only useful for tests.
 */
export interface BridgeServerOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly host?: string;
}

/**
 * One pending item in `GET /v1/pending`.
 *
 * `kind` discriminates between the two trackable event types in v1:
 * - `question`: a `user-input.requested` activity that has not been resolved
 * - `permission`: an `approval.requested` activity that has not been resolved
 *
 * v2 will add `plan`, `session-error`, and `signed-out` to this union.
 */
export type PendingItemKind = "question" | "permission";

export interface PendingItem {
  readonly id: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly kind: PendingItemKind;
  readonly summary: string;
  readonly createdAt: string;
}

/**
 * The aggregate response shape for `GET /v1/pending`. Threads group items so
 * the QML panel can render one row per thread with the items underneath.
 */
export interface PendingResponse {
  readonly totalCount: number;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly items: ReadonlyArray<PendingItem>;
  }>;
}

/**
 * Body shape for `POST /v1/respond`.
 *
 * Either `decision` (for permissions) or `answers` (for questions) is set;
 * not both. The server validates this and returns 400 on mismatch.
 */
export interface PendingResponseInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly decision?: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
  readonly answers?: Readonly<Record<string, unknown>>;
}