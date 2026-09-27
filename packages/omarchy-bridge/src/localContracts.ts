/**
 * Local placeholder for `@t3tools/contracts`.
 *
 * TODO: this file goes away once we publish (or workspace-link) the real
 * `@t3tools/contracts` package from the t3code repo. The structural types
 * here match the shape we currently consume; replace the file with a
 * single `export * from "@t3tools/contracts"` and delete the local types.
 *
 * Keep these branded types here exactly once — duplication across the
 * codebase is what bit us when the contract drifted in v0.1.
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