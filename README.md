# Hommies

A Omarchy bar plugin that surfaces pending **questions** and **permission requests** from
coding agents (Claude Code, Codex, OpenCode, Omacode, or any agent with command hooks) so you don't miss
them when you're away from the chat UI.

## Why

YouTube, email, a meeting — and your agent has been waiting on a question for an hour.
`hommies` puts **Hommie** on your screen: the Omarchy mark with a pair of eyes, floating
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
- **Any agent**: point another agent's command hooks at `hommies-hook --agent <name>`
  and it shows up under an **Other** tab.
- **Desktop notifications** for new items, and optional **sounds** (off by default), each
  with a toggle in the panel.

`hommies setup` lets you pick the agents to hook up from the ones it finds. See
[`packages/omarchy-bridge/README.md`](packages/omarchy-bridge/README.md) for setup and the HTTP API.

## Packages

This is a pnpm workspace with two packages:

| Path | What it is |
| --- | --- |
| `packages/omarchy-bridge/` | A TypeScript npm package: the loopback HTTP bridge (`/v1/pending`, `/v1/respond`, `/v1/focus`, the provider routes, ...), the agent hooks, the OpenCode plugin, and the `hommies` setup CLI. Published to npm as `@thisisayande/hommies`. |
| `packages/bell-plugin/` | The Omarchy plugin itself: `manifest.json`, `Service.qml` (starts the bridge and hosts Hommie), `FloatingBuddy.qml` and `FloatingPanel.qml` (the floating character and its card), `characters/Hommie.qml`, the bar bell (`BarWidget.qml`, `Panel.qml`), and `bridge.js`, which talks to the bridge over HTTP. Distributed as a folder consumable by `omarchy plugin add`. |

## Status

Working end to end, not yet published to the plugin marketplace.

- **Bridge** (`@thisisayande/hommies`): the HTTP API, the Claude Code and Codex
  command hooks, the OpenCode plugin, the generic `hommies-hook`, desktop
  notifications, sounds, and `hommies setup` are implemented and tested.
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
Hommies/
├── packages/
│   ├── omarchy-bridge/   # TS bridge, hooks, OpenCode plugin, setup CLI
│   └── bell-plugin/      # QML + manifest.json; runs hommies-bridge
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
   npm install -g @thisisayande/hommies
   hommies setup --dry-run   # preview the config changes
   hommies setup
   ```

   In a terminal, setup lists the agents it found and lets you pick which ones
   to set up (`--yes` takes every installed agent; `--only` names them). It backs
   up every config it changes. For Codex, approve the new hooks in its `/hooks`
   screen; restart OpenCode to load its plugin. `hommies setup --check` tells you
   later whether the hooks are still current.

2. Add the plugin to the bar. Until it is on the marketplace, link it from a checkout:

   ```sh
   ln -s "$PWD/packages/bell-plugin" ~/.config/omarchy/plugins/io.github.ayandexyz.hommies
   omarchy-shell shell rescanPlugins
   ```

   The published plugin lives in its own repository,
   [ayandexyz/hommies-plugin](https://github.com/ayandexyz/hommies-plugin):
   `omarchy plugin add https://github.com/ayandexyz/hommies-plugin`. Copy changes
   from `packages/bell-plugin/` there when you release.

To remove it, run `hommies uninstall` before `npm uninstall -g @thisisayande/hommies`
(npm no longer runs uninstall scripts, so it cannot remove the hooks for you). Hooks
left behind by a bare `npm uninstall` do nothing, except OpenCode's plugin entry,
which you then remove from `opencode.json` by hand.

The plugin starts the bridge (`hommies-bridge`) as a background service and
restarts it if it exits. After updating the bridge package, run
`omarchy restart shell` so the running bridge picks up the new code.

## License

MIT.
