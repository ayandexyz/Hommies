# agent-fold bell plugin

The Omarchy plugin half of `agent-fold`. The other half — `@agent-fold/bridge` —
runs the daemon this plugin talks to.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Plugin contract: kinds, entry points, namespace. |
| `BarWidget.qml` | The bell glyph in the bar. Counts pending items, opens the panel on click. |
| `Panel.qml` | Lists pending items by provider and renders Claude's structured question controls. |
| `Service.qml` | Headless singleton that owns the bridge daemon process. |
| `bridge.js` | JS module loaded by the QML files. Talks to the bridge over `127.0.0.1`. |

## Claude answer surface

The widget setting **Answer Claude questions in** controls question ownership:

- **Top bar** keeps the PreToolUse hook open and returns the selected options to Claude.
- **Claude CLI** lets Claude render its native prompt while the top bar shows a read-only
  structured mirror. PostToolUse clears the mirror after the CLI answer.

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
