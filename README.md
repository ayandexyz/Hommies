# agent-fold

A Omarchy bar plugin that surfaces pending **questions** and **permission requests** from
coding agents (Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity) so you don't miss
them when you're away from the chat UI.

## Why

YouTube, email, a meeting — and your agent has been waiting on a question for an hour.
`agent-fold` lives in the Omarchy top bar as a bell that shows the pending count, grouped
by agent, with a click-through to the thread.

## Packages

This is a pnpm workspace with two packages:

| Path | What it is |
| --- | --- |
| `packages/omarchy-bridge/` | A TypeScript npm package. Embeds a thin slice of the T3 Code orchestration layer and exposes a localhost HTTP surface (`GET /v1/pending`, `POST /v1/respond`, `GET /v1/stream`). Published to npm as `@agent-fold/bridge`. |
| `packages/bell-plugin/` | The Omarchy plugin itself: `manifest.json`, `BarWidget.qml`, `Panel.qml`, `bridge.mjs`. The QML plugin loads `bridge.mjs`, which talks to the bridge daemon over HTTP. Distributed as a folder consumable by `omarchy plugin add`. |

## Status

The first vertical slice, Claude Code permission requests, is implemented in
the bridge: its command hook waits for a response from the local HTTP API and
returns Claude's documented allow/deny decision. The daemon lifecycle and QML
client controls are still pending, so this is currently a provider integration
and API rather than an installable end-to-end plugin.

## Layout

```
agent-fold/
├── packages/
│   ├── omarchy-bridge/   # TS, Effect-based, embeds ProjectionPipeline + adapters
│   └── bell-plugin/      # QML + manifest.json, depends on @agent-fold/bridge
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── AGENTS.md
└── README.md
```

## Install (target, not yet working)

Once `packages/bell-plugin/` is publishable:

```sh
omarchy plugin add <this-repo>#path:packages/bell-plugin --enable
```

The bridge daemon is launched by the plugin on first load and runs in the background as
a Quickshell `service`-kind singleton.

## License

MIT.
