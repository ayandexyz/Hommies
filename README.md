# agent-fold

A Omarchy bar plugin that surfaces pending **questions** and **permission requests** from
coding agents (Claude Code, Codex, OpenCode, Omacode, Cursor, Grok, Antigravity) so you don't miss
them when you're away from the chat UI.

## Why

YouTube, email, a meeting — and your agent has been waiting on a question for an hour.
`agent-fold` lives in the Omarchy top bar as a bell that shows the pending count, grouped
by agent, with a click-through to the thread.

## Features

- **Answer from the bar**: permission requests and questions from Claude Code, Codex,
  OpenCode, and Omacode, grouped by agent and session. **Always** saves the rule for
  Claude Code and OpenCode, so the same request does not ask again.
- **Turn ends**: a session that stopped with a question in plain text shows as waiting
  for your reply; one that simply finished shows as done.
- **Live activity**: each running session shows whether it is thinking or working,
  with its latest steps (`> fix the build`, `Bash pnpm test`, `Edit server.ts`). A dot
  next to the bell means an agent is busy.
- **Errors and rate limits**: a turn that stopped on an API error or a usage limit shows
  in red or orange, so you know the agent is stuck rather than done.
- **Go to terminal**: focus the exact Hyprland window (and tmux pane) a session runs in.
- **Any agent**: point another agent's command hooks at `agent-fold-hook --agent <name>`
  and it shows up under an **Other** tab.
- **Desktop notifications** for new items, and optional **sounds** (off by default), each
  with a toggle in the panel.

`agent-fold setup` registers the hooks for every agent it finds. See
[`packages/omarchy-bridge/README.md`](packages/omarchy-bridge/README.md) for setup and the HTTP API.

## Packages

This is a pnpm workspace with two packages:

| Path | What it is |
| --- | --- |
| `packages/omarchy-bridge/` | A TypeScript npm package. Embeds a thin slice of the T3 Code orchestration layer and exposes a localhost HTTP surface (`GET /v1/pending`, `POST /v1/respond`, `GET /v1/stream`). Published to npm as `@thisisayande/agent-fold`. |
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
│   └── bell-plugin/      # QML + manifest.json, depends on @thisisayande/agent-fold
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
