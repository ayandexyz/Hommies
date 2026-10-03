# agent-fold — agent instructions

## Project shape

pnpm workspace monorepo with two packages.

- `packages/omarchy-bridge/` — `@thisisayande/hommies` (npm). TypeScript + Effect.
  A localhost HTTP daemon (`startBridgeServer` in `src/server.ts`) plus four
  provider adapters that feed it:
  - Claude Code: blocking command hooks (`src/claude-hook.ts`, bin `agent-fold-claude-hook`).
  - Codex: blocking command hooks (`src/codex-hook.ts`, bin `agent-fold-codex-hook`).
  - OpenCode: in-process plugin (`src/opencode-plugin.ts`, export `AgentFoldOpenCode`).
  - Omacode: built-in to the agent itself; Omacode talks to the same endpoints as OpenCode.
  Shared branded ID types and provider kinds live in `src/localContracts.ts`.
- `packages/bell-plugin/` — Omarchy plugin distributed as a folder consumed by
  `omarchy plugin add`. QML (`BarWidget.qml` entry, `Panel.qml` loaded via
  `Loader`, `Service.qml` daemon supervisor, `ProviderLogo.qml` shared
  component) plus `bridge.js` (the only thing that talks to the bridge) and
  `manifest.json` declaring `kinds: ["bar-widget", "service"]`.

## Hard constraints

- **The QML plugin runs inside the Omarchy Quickshell process.** Unsandboxed,
  inherits the user's permissions. Never spawn a second Quickshell. Never
  execute downloaded code without review.
- **No telemetry, no analytics, no auto-update pings.** The bridge is
  local-only; `server.ts` rejects any host that is not `127.0.0.1` or `::1`
  and exits when the shell exits. All HTTP routes (except `OPTIONS` and
  `GET /healthz`) require the `x-agent-fold-token` header whose value is
  written to `port.json` by `startBridgeServer`.

## Local development

```sh
pnpm install
pnpm -r build         # bridge: tsc -p tsconfig.json; bell-plugin: no build step
pnpm -r typecheck     # bridge only (bell-plugin has no typecheck)
pnpm -r test          # bridge only; builds first, then runs test/*.test.mjs
```

`pnpm -r lint` is a no-op stub (echoes and exits 0) — no linter is
configured yet. The root `tsconfig.base.json` sets `noEmit: true`; the
bridge emits via its own `packages/omarchy-bridge/tsconfig.json`.

Single-package verification:

```sh
pnpm --filter @thisisayande/hommies build
pnpm --filter @thisisayande/hommies typecheck
pnpm --filter @thisisayande/hommies test
```

Validate QML against the installed Omarchy shell:

```sh
qmllint -I "$OMARCHY_PATH/shell" packages/bell-plugin
```

The bell-plugin package has no `package.json` and no `node_modules` of its
own; `pnpm -r build` is a no-op for it.

## Runtime wiring (read this before touching `Service.qml` or `BarWidget.qml`)

1. `Service.qml` starts `agent-fold-bridge --data-dir <XDG_DATA_HOME>/agent-fold --port 0`
   on shell startup; on exit a 3 s timer restarts it. The daemon picks a free
   port, generates a 32-byte token, and writes `{ port, token, version: 1 }`
   to `<dataDir>/port.json` with mode `0o600`.
2. `BarWidget.qml` watches that `port.json` via `FileView`; on change it
   calls `bridge.js#configure({ port, token })` and starts polling
   `GET /v1/pending` every 3 s. `bridge.js` is a `.pragma library` (no
   `import`/`export`) and is loaded with `import "bridge.js" as Bridge`.
3. Hook adapters discover the daemon by reading `port.json` directly
   (`src/hook-common.ts#readConnection`). They honour
   `AGENT_FOLD_DATA_DIR` to override the default
   `$XDG_DATA_HOME/agent-fold` (falling back to `~/.local/share/agent-fold`).
4. `POST /v1/preferences` syncs the two user settings
   (`questionAnswerSurface: topbar|cli`, `desktopNotifications: bool`) from the
   QML panel into the bridge; settings are declared in `manifest.json` and
   read via the `setting(...)` API.

## HTTP surface (`src/server.ts`)

Implemented and contract-stable. Anything published here is part of the
plugin's contract with installed copies; preserve it.

- `GET /healthz` — unauthenticated liveness probe.
- `GET /v1/pending` → `PendingResponse` (totalCount + threads).
- `GET /v1/stream` — SSE; emits `event: pending` with the same payload as
  `GET /v1/pending`. The QML panel does not consume this yet (it polls);
  `bridge.js#subscribe` is a stub that returns an unsubscribe no-op.
- `POST /v1/respond` — body is `PendingResponseInput` (`threadId`,
  `requestId`, plus either `decision: accept|decline|cancel` or `answers`).
- `POST /v1/preferences` — `BridgePreferencesInput`.
- Provider hooks (POST): `/v1/providers/claude/{permission,question,question/resolved}`,
  `/v1/providers/codex/permission`,
  `/v1/providers/{opencode,omacode}/{permission,question,permission/resolved,question/resolved}`,
  `/v1/providers/{claude,codex,opencode,omacode}/{stop,resume}`.
- `kind` values on `PendingItem`: `question | permission | attention | finished`.
  v2 will add `plan | session-error | signed-out` (see the `// TODO` in
  `src/types.ts`).

Response timeouts: 5 min for questions/permissions (`responseTimeoutMs`),
12 h for `attention`/`finished` (`attentionTimeoutMs`). A disconnected hook
(cancel, kill, timeout) releases any waiting question so the bar does not
hang on a request nobody owns — see `onHookDisconnect` in `server.ts`.

## Style

- TypeScript strict (`strict`, `noUncheckedIndexedAccess`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` from
  `tsconfig.base.json`). No `any` in `packages/omarchy-bridge`.
- QML follows the built-in `omarchy.clock` plugin: `BarWidget.qml` is the
  entry point, `Panel.qml` is loaded by it via a `Loader`. `moduleName`
  MUST match the manifest id (`io.github.ayandexyz.hommies`) across
  `BarWidget.qml`, `Panel.qml`, and `Service.qml`.
- `bridge.js` is a `.pragma library` plain JS module (no build step).
  Functions return Promises; BarWidget always logs failures via
  `console.warn("agent-fold ...")` and never throws into Quickshell.
- Provider-specific provider ids and labels live in `providerLabels` and
  `hasRequestIds` (`src/server.ts`); add a new provider there, in
  `localContracts.ts`'s `ProviderDriverKind`, and in the manifest schema
  options. OpenCode and Omacode use their own request ids
  (`per_...` / `que_...`) so a TUI answer can clear the bar item — see
  `RequestIdProvider` and `resolveRequestId{Question,Permission}`.
- Notification text is HTML-escaped (`notifier.ts#escapeMarkup`) before
  being handed to `notify-send`. Failures of the notifier are swallowed.

## Tests (`packages/omarchy-bridge/test/`)

Plain `node:test` (`*.test.mjs`), run against the built `dist/` (the
package's `test` script does `pnpm run build && node --test`). Each test
boots a real `startBridgeServer` against `mkdtemp` and uses `fetch` to
exercise the HTTP surface end-to-end:

- `permissions.test.mjs` — accept/decline/cancel and hook disconnect.
- `question-surfaces.test.mjs` — topbar vs cli answer surfaces.
- `notifications.test.mjs` — desktop notification dispatch.
- `stop-detection.test.mjs` — `detectReplyRequest` heuristic.
- `codex.test.mjs`, `opencode.test.mjs`, `omacode.test.mjs` — provider
  adapters (the OpenCode/Omacode tests drive the plugin's helpers; they
  do not spawn OpenCode).

## What is NOT done yet

- `packages/bell-plugin/` is not publishable as an Omarchy plugin from
  this repo (no `package.json`, no install path). The `omarchy plugin add
  <this-repo>#path:packages/bell-plugin --enable` install described in the
  README is the target, not a working command yet.
- `Service.qml` calls `agent-fold-bridge` directly from `$PATH`; the
  bridge must be installed via `npm i -g @thisisayande/hommies` for the
  plugin to find it (or via Omarchy's plugin runtime that resolves the
  npm-installed copy).
- `docs/plan.md` does not exist; the extraction plan lives in this file.