# agent-fold bell plugin

The Omarchy plugin half of `agent-fold`. The other half — `@agent-fold/bridge` —
runs the daemon this plugin talks to.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Plugin contract: kinds, entry points, namespace. |
| `BarWidget.qml` | The bell glyph in the bar. Counts pending items, opens the panel on click. |
| `Panel.qml` | Lists pending items grouped by thread. Inline answering is v2; v1 deep-links to T3 Code. |
| `Service.qml` | Headless singleton that owns the bridge daemon process. |
| `bridge.mjs` | JS module loaded by the QML files. Talks to the bridge over `127.0.0.1`. |

## Status

v0 scaffold. `bridge.mjs` returns an empty list and the panel renders no items.
The shape and naming are real; the daemon integration is the next step.

## Local development

```sh
# Validate the manifest
omarchy plugin validate packages/bell-plugin

# Lint the QML against the installed shell
qmllint -I "$OMARCHY_PATH/shell" packages/bell-plugin/BarWidget.qml packages/bell-plugin/Panel.qml packages/bell-plugin/Service.qml
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