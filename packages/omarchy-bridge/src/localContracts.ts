/**
 * Local provider contract types shared across the bridge.
 *
 * These structural types match the hook payloads and projection shapes we
 * currently consume. Keep them declared exactly once — duplication across
 * the codebase is what bit us when the contract drifted in v0.1.
 *
 * Promote them to a published npm package only when another consumer needs
 * them; until then this file is the single source of truth.
 */

declare const ApprovalRequestIdBrand: unique symbol;
export type ApprovalRequestId = string & { readonly [ApprovalRequestIdBrand]: void };

declare const ProviderDriverKindBrand: unique symbol;
export type ProviderDriverKind =
  | "claude"
  | "codex"
  | "opencode"
  | "omacode"
  | "cursor"
  | "grok"
  | "antigravity"
  | (string & { readonly [ProviderDriverKindBrand]: void });

declare const ThreadIdBrand: unique symbol;
export type ThreadId = string & { readonly [ThreadIdBrand]: void };

export const ApprovalRequestId = (value: string): ApprovalRequestId =>
  value as ApprovalRequestId;
export const ThreadId = (value: string): ThreadId => value as ThreadId;