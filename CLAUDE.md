# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

agent-fold is an Omarchy top-bar plugin (a bell) that shows pending **permission requests**, **questions**, and **turn ends** from coding agents (Claude Code, Codex, OpenCode, Omacode) and lets you answer some of them from the bar. `AGENTS.md` has the project rules. Its "What is NOT done yet" section is out of date: the server, the HTTP routes, and the QML client are all implemented now.

## Commands

pnpm workspace (Node >= 20.10, pnpm 9). Run from the repo root:

```sh
pnpm install
pnpm build        # tsc for packages/omarchy-bridge
pnpm test         # bridge: builds, then runs `node --test test/*.test.mjs`
pnpm typecheck
```

The tests import from `dist/`, so build before running any single test file:

```sh
cd packages/omarchy-bridge
pnpm run build && node --test test/permissions.test.mjs
node --test --test-name-pattern "accept" test/permissions.test.mjs
```

`lint` is a no-op placeholder. The QML plugin has no build step. Validate it with:

```sh
omarchy plugin validate packages/bell-plugin
qmllint -I "$OMARCHY_PATH/shell" packages/bell-plugin/*.qml
```

To try the plugin locally, symlink it into `~/.config/omarchy/plugins/io.github.ayan-de.agent-fold` and run `omarchy-shell shell rescanPlugins`.

## Architecture

There are three processes, and they only talk to each other over loopback HTTP:

1. **Agent-side adapters** run inside or next to each agent and POST to the bridge:
   - `claude-hook.ts` and `codex-hook.ts` are command-hook binaries. They read the hook JSON from stdin, read `port.json`, and POST to `/v1/providers/{claude,codex}/...`. `PermissionRequest` and the Claude `AskUserQuestion` PreToolUse hook block until the bar answers (timeout about 305s). Turn hooks (`Stop`, `UserPromptSubmit`, `SessionEnd`) never block and never write to stdout. Shared code lives in `hook-common.ts`.
   - `opencode-plugin.ts` is an OpenCode server plugin that runs inside OpenCode and uses the `/v1/providers/opencode/{permission,question}[/resolved]` request-id protocol.
   - Omacode (FreeCode) has its own built-in integration upstream (`apps/core/src/hooks/builtin/agent-fold.ts` in the freecode repo) that uses the same protocol under `/v1/providers/omacode/*`.
   - **Fail-open rule:** if the bridge is not running, every adapter exits without a decision, so the agent falls back to its own native prompt. Keep this behavior.
2. **The bridge daemon** (`packages/omarchy-bridge`): `runtime.ts` is the `agent-fold-bridge` CLI, which calls `startBridgeServer` in `server.ts`. `server.ts` does almost all of the work. All state is kept in memory (pending permissions, questions, and attention/finished items, with a 12h attention timeout) and is lost when the process exits. The server binds to `127.0.0.1` and writes `{port, token, version}` to `$AGENT_FOLD_DATA_DIR` or `$XDG_DATA_HOME/agent-fold/port.json`. Every request must carry the `x-agent-fold-token` header. `stop-detection.ts` classifies the final assistant message (read from the hook payload or from the transcript via `transcript.ts` / `codex-transcript.ts`) as an `attention` item (a plain-text question) or a `finished` item. `notifier.ts` shells out to `notify-send`.
3. **The QML plugin** (`packages/bell-plugin`) runs inside the Omarchy Quickshell process. `Service.qml` spawns `agent-fold-bridge` and restarts it when it exits. `BarWidget.qml` reads `port.json`, polls `/v1/pending` every 3s through `bridge.js` (XHR; `subscribe`/SSE is still a stub), and loads `Panel.qml` through a `Loader`. `Panel.qml` renders items grouped by provider and posts to `/v1/respond` and `/v1/preferences`.

Item kinds are `permission | question | attention | finished`. The answer-surface preference is `topbar | cli`, shown in the UI as "Top bar" / "Claude CLI". In `cli` mode, questions are mirrored read-only in the bar and the agent's own prompt owns the answer. For OpenCode and Omacode, both the bar and the agent's TUI can answer, and whichever answers first wins.

Public types live in `types.ts`. `localContracts.ts` holds local structural stand-ins for `@t3tools/contracts` until that package is published.

## Constraints (from AGENTS.md)

- The HTTP surface (`/v1/*`, `port.json` format) is a contract with installed plugin copies and agent adapters, so keep it backward-compatible. A breaking change needs a new versioned path (`/v2/...`).
- Do not vendor T3 Code source. Add missing features upstream (`~/Projects/githubProjects/t3code`) and consume them through npm.
- The QML runs unsandboxed inside the user's Quickshell. Never start a second Quickshell process.
- No telemetry, analytics, or update pings. The bridge is loopback-only.
- TypeScript is strict, and `any` is not allowed in the bridge. QML follows the `omarchy.clock` plugin pattern: `BarWidget.qml` is the entry point and loads `Panel.qml`, with the same `moduleName` in both.
- Setup docs for each provider's hooks (Claude `settings.json`, Codex `hooks.json`, OpenCode `opencode.json`) are in `packages/omarchy-bridge/README.md`. Update them when you change hook behavior.
