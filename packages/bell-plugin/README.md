# Hommies plugin

The Omarchy plugin half of `agent-fold`. The other half — `@thisisayande/hommies` —
runs the daemon this plugin talks to.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Plugin contract: kinds, entry points, namespace. |
| `BarWidget.qml` | The bell glyph in the bar. Counts pending items, opens the panel on click. |
| `Panel.qml` | Lists pending items by provider and renders Claude's, OpenCode's, and Omacode's structured question controls. |
| `Service.qml` | Singleton that owns the bridge daemon process and hosts the floating character (polling, preferences, mood). |
| `FloatingBuddy.qml` | The floating character window. Click it to open the agent tabs in a card beside it, right-click for its settings menu, drag it to move it. |
| `FloatingPanel.qml` | The floating card: provider tabs, sessions, and items only (no settings, no outdated-hooks notice). A separate copy of `Panel.qml` so the two UIs can diverge. |
| `characters/*.qml` | Swappable characters. `Hommie.qml` (the Omarchy mark with eyes) is the default. |
| `bridge.js` | JS module loaded by the QML files. Talks to the bridge over `127.0.0.1`. |

## Floating character

The service shows a floating character instead of relying on the bar bell. Its
mood follows the most urgent item: approval, question, error, rate limit,
working, thinking, finished, idle, and sleeping after 10 minutes of nothing.
Right-click the character for its settings: answer questions here or in the
agent CLI, desktop notifications, sounds, "Over fullscreen", and moving it to
the next monitor. It shows above fullscreen windows by default; turn off "Over
fullscreen" to keep it under them (for example, under a fullscreen video).
Its preferences (answer surface, notifications, sounds, over fullscreen,
position, monitor, and `character`) are saved in `$XDG_DATA_HOME/agent-fold/floating.json`. The bar
bell still works. If you keep both, they share the same bridge preferences, so
remove the bell from the bar to avoid toggling them from two places.

To swap the character, add `characters/<Name>.qml` implementing the contract at
the top of `characters/Hommie.qml` (`mood`, `lookX`, `lookY`, `running`,
`poke()`), then set `"character": "<Name>"` in `floating.json`.

## Answer surface

The widget setting **Answer agent questions in** controls question ownership:

- **Top bar** keeps the PreToolUse hook open and returns the selected options to Claude.
  OpenCode and Omacode questions show in both the bar and the agent's TUI; whichever
  answers first wins, and the other one clears.
- **Claude CLI** (the stored value keeps its original name) lets the agent render its
  native prompt while the top bar shows a read-only structured mirror, which clears
  once the question is answered.

## Local development

```sh
# Validate the manifest
omarchy plugin validate packages/bell-plugin

# Lint the QML against the installed shell
qmllint -I "$OMARCHY_PATH/shell" packages/bell-plugin/BarWidget.qml packages/bell-plugin/Panel.qml packages/bell-plugin/ProviderLogo.qml packages/bell-plugin/Service.qml packages/bell-plugin/FloatingBuddy.qml packages/bell-plugin/characters/Hommie.qml
```

To try the plugin locally, copy the folder into `~/.config/omarchy/plugins/`:

```sh
ln -s "$(pwd)/packages/bell-plugin" "$HOME/.config/omarchy/plugins/io.github.ayandexyz.hommies"
omarchy-shell shell rescanPlugins
```

## Manifest id

The plugin ID is `io.github.ayandexyz.hommies`. It is permanent: the marketplace
listing, the plugin's install directory, and its saved settings are all keyed on it.
