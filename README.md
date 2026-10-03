# agent-fold

A Omarchy bar plugin that surfaces pending **questions** and **permission requests** from
coding agents (Claude Code, Codex, OpenCode, Omacode, or any agent with command hooks) so you don't miss
them when you're away from the chat UI.

## Why

YouTube, email, a meeting — and your agent has been waiting on a question for an hour.
`agent-fold` puts **Hommie** on your screen: the Omarchy mark with a pair of eyes, floating
wherever you drag it. Hommie shows at a glance whether your agents are working, waiting on
you, failed, or done, and one click opens the pending items grouped by agent. The classic
top-bar bell is still available.

## Features

- **Hommie, a floating companion**: an Omarchy-mark face that follows the active theme's
  colors. Its eyes follow your pointer; it bounces for approvals, tilts for questions,
  shakes on errors, sweeps a light around its frame while agents work or think, hops when
  a turn finishes, and falls asleep when nothing is running. Click it for the agent tabs,
  right-click for settings, drag to move it. It shows over fullscreen windows unless you
  turn **Over fullscreen** off.
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
| `packages/omarchy-bridge/` | A TypeScript npm package: the loopback HTTP bridge (`/v1/pending`, `/v1/respond`, `/v1/focus`, the provider routes, ...), the agent hooks, the OpenCode plugin, and the `agent-fold` setup CLI. Published to npm as `@thisisayande/agent-fold`. |
| `packages/bell-plugin/` | The Omarchy plugin itself: `manifest.json`, `Service.qml` (starts the bridge and hosts Hommie), `FloatingBuddy.qml` and `FloatingPanel.qml` (the floating character and its card), `characters/Hommie.qml`, the bar bell (`BarWidget.qml`, `Panel.qml`), and `bridge.js`, which talks to the bridge over HTTP. Distributed as a folder consumable by `omarchy plugin add`. |

## Status

Working end to end, not yet published to the plugin marketplace.

- **Bridge** (`@thisisayande/agent-fold`): the HTTP API, the Claude Code and Codex
  command hooks, the OpenCode plugin, the generic `agent-fold-hook`, desktop
  notifications, sounds, and `agent-fold setup` are implemented and tested.
- **Plugin**: the service starts the bridge, restarts it when it exits, and polls
  `/v1/pending` every 3 seconds. Hommie's card (and the bar bell's panel) answers
  permissions and questions and shows live activity, failures, and the jump-to-terminal
  button.
- **Omacode** ships its own integration upstream.

Not done yet:

- `GET /v1/stream` (SSE) exists in the bridge, but the plugin still polls.
- Codex has no failure hook and rejects saved permission rules, so its failed turns
  are not reported and it gets no **Always** button.
- Omacode does not report live activity yet.
- Custom agents' permission requests are not answered from the bar.
- The bridge keeps everything in memory, so pending items are lost when it restarts.

See [`docs/roadmap.md`](docs/roadmap.md) for what was planned and how it turned out.

## Layout

```
agent-fold/
├── packages/
│   ├── omarchy-bridge/   # TS bridge, hooks, OpenCode plugin, setup CLI
│   └── bell-plugin/      # QML + manifest.json; runs agent-fold-bridge
├── docs/roadmap.md
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── AGENTS.md
└── README.md
```

## Install

1. Install the bridge and register the agent hooks:

   ```sh
   npm install -g @thisisayande/agent-fold
   agent-fold setup --dry-run   # preview the config changes
   agent-fold setup
   ```

   Setup backs up every config it changes. For Codex, approve the new hooks in its
   `/hooks` screen; restart OpenCode to load its plugin. `agent-fold setup --check`
   tells you later whether the hooks are still current.

2. Add the plugin to the bar. Until it is on the marketplace, link it from a checkout:

   ```sh
   ln -s "$PWD/packages/bell-plugin" ~/.config/omarchy/plugins/io.github.ayan-de.agent-fold
   omarchy-shell shell rescanPlugins
   ```

   Once published, this becomes
   `omarchy plugin add <this-repo>#path:packages/bell-plugin --enable`.

The plugin starts the bridge (`agent-fold-bridge`) as a background service and
restarts it if it exits. After updating the bridge package, run
`omarchy restart shell` so the running bridge picks up the new code.

## License

MIT.
