# agent-fold bell plugin

The Omarchy plugin half of `agent-fold`. The other half — `@agent-fold/bridge` —
runs the daemon this plugin talks to.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Plugin contract: kinds, entry points, namespace. |
| `BarWidget.qml` | The bell glyph in the bar. Counts pending items, opens the panel on click. |
| `Panel.qml` | Lists pending items by provider and renders Claude's and OpenCode's structured question controls. |
| `Service.qml` | Headless singleton that owns the bridge daemon process. |
| `bridge.js` | JS module loaded by the QML files. Talks to the bridge over `127.0.0.1`. |

## Answer surface

The widget setting **Answer agent questions in** controls question ownership:

- **Top bar** keeps the PreToolUse hook open and returns the selected options to Claude.
  OpenCode questions show in both the bar and OpenCode's TUI; whichever answers first
  wins, and the other one clears.
- **Claude CLI** (the stored value keeps its original name) lets the agent render its
  native prompt while the top bar shows a read-only structured mirror, which clears
  once the question is answered.

## Local development

```sh
# Validate the manifest
omarchy plugin validate packages/bell-plugin

# Lint the QML against the installed shell
qmllint -I "$OMARCHY_PATH/shell" packages/bell-plugin/BarWidget.qml packages/bell-plugin/Panel.qml packages/bell-plugin/ProviderLogo.qml packages/bell-plugin/Service.qml
```

To try the plugin locally, copy the folder into `~/.config/omarchy/plugins/`:

```sh
ln -s "$(pwd)/packages/bell-plugin" "$HOME/.config/omarchy/plugins/io.github.ayan-de.agent-fold"
omarchy-shell shell rescanPlugins
```

## Manifest id

`io.github.ayan-de.agent-fold` is a placeholder namespace. Replace it with one you
own before the first install (Omarchy rejects third-party IDs that start with
`omarchy.`).
