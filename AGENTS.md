# agent-fold — agent instructions

## Project shape

This is a **pnpm workspace monorepo** with two packages:

- `packages/omarchy-bridge/` — TypeScript. Embeds a thin slice of T3 Code's orchestration
  layer (the Effect-based projection pipeline + provider adapters) and exposes a localhost
  HTTP surface for the QML plugin. Published to npm as `@agent-fold/bridge`.
- `packages/bell-plugin/` — Omarchy plugin. QML + JS + `manifest.json`. Distributed as a
  folder consumable by `omarchy plugin add`. Depends on `@agent-fold/bridge` at runtime via
  the npm-installed copy, not via local workspace link — the bridge runs as a Node child
  process owned by the `service`-kind plugin.

## Hard constraints

- **Do not vendor T3 Code source into this repo.** The bridge depends on `@t3tools/contracts`
  and a future `@t3code/server-core` package via npm. If you need a feature, add it to
  `server-core` upstream in `~/Projects/githubProjects/t3code` and consume it here.
- **The QML plugin runs inside the Omarchy Quickshell process.** It is unsandboxed and
  inherits the user's permissions. Never run a second Quickshell process for this plugin.
  Never execute downloaded code without review.
- **No telemetry, no analytics, no auto-update pings.** The bridge is local-only; it binds
  to `127.0.0.1` and exits when the shell exits.

## Local development

```sh
pnpm install
pnpm -r build
pnpm -r test
```

The bridge package builds with `tsc`; the bell plugin is plain QML/JS (no build step,
but `qmllint -I "$OMARCHY_PATH/shell" packages/bell-plugin` validates it against the
installed shell).

## Style

- TypeScript strict mode is the default. No `any` in the bridge package.
- QML follows the built-in `omarchy.clock` plugin: `BarWidget.qml` is the entry point,
  `Panel.qml` is loaded by it via a `Loader`. Keep `moduleName` consistent across both.
- The bridge HTTP surface must be backward-compatible. Anything we publish is part of the
  plugin's contract with installed copies.

## What is NOT done yet (v0 scaffold)

- The bridge daemon has no `startBridgeServer()` body — only the package skeleton.
- The QML plugin's `bridge.mjs` is a stub that returns an empty list.
- The HTTP surface (`GET /v1/pending`, `POST /v1/respond`, `GET /v1/stream`) is not
  implemented.

See `docs/plan.md` (TODO) for the extraction plan.