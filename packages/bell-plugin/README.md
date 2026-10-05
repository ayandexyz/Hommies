# Hommies plugin

The Omarchy plugin half of `hommies`. The other half — `@thisisayande/hommies` —
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
| `markdown.js` | Turns an agent's final message into Qt StyledText for **Show full message**. Escapes all agent text and adds only formatting tags (no images or links). |

## Floating character

The service shows a floating character instead of relying on the bar bell. Its
mood follows the most urgent item: approval, question, error, rate limit,
working, thinking, finished, idle, and sleeping after 10 minutes of nothing.
Right-click the character for its settings: answer questions here or in the
agent CLI, desktop notifications, sounds, "Over fullscreen", and moving it to
the next monitor. It shows above fullscreen windows by default; turn off "Over
fullscreen" to keep it under them (for example, under a fullscreen video).
Its preferences (answer surface, notifications, sounds, over fullscreen,
position, monitor, and `character`) are saved in `$XDG_DATA_HOME/hommies/floating.json`. The bar
bell still works. If you keep both, they share the same bridge preferences, so
remove the bell from the bar to avoid toggling them from two places.

### Outfits

Right-click Hommie and use **Outfit ‹ ›** to dress him: a party hat, beanie,
crown, Santa hat, pumpkin, bow, glasses, sunglasses, or a scarf. They are
pixel art in the mark's own grid, coloured from the theme, and they tilt,
squash, and hop with him. Status badges are drawn on top, so an outfit never
hides an alert. **Auto** (the default) dresses him for the season: a pumpkin
from 20 October, a Santa hat in December, and a party hat on 31 December and
1 January; otherwise he wears nothing. The choice is saved as `outfit` in
`floating.json`. `node scripts/render-preview.mjs --outfits` renders every
outfit into one image.

To swap the character, add `characters/<Name>.qml` implementing the contract at
the top of `characters/Hommie.qml` (`mood`, `lookX`, `lookY`, `running`,
`poke()`, and optionally `emote(name)` for the greeting, celebrate jump, and idle emotes), then set `"character": "<Name>"` in `floating.json`.

## Keyboard shortcuts

### Global (Hyprland binds)

Plugins cannot bind keys, so Hommies exposes its actions over shell IPC on the
`hommies` target, and you bind them in your own Hyprland config. With
Omarchy's Lua bindings (`~/.config/hypr/bindings.lua`):

```lua
o.bind("SUPER + ALT + A", "Hommies: answer next", "omarchy-shell hommies jumpToPending")
o.bind("SUPER + ALT + H", "Hommies: toggle card", "omarchy-shell hommies toggle")
o.bind("SUPER + ALT + T", "Hommies: go to agent terminal", "omarchy-shell hommies focusTerminal")
o.bind("SUPER + ALT + M", "Hommies: toggle sounds", "omarchy-shell hommies toggleSounds")
```

The keys are only examples; pick ones your config does not use. With a
classic `bindings.conf`:

```ini
bindd = SUPER ALT, A, Hommies: answer next, exec, omarchy-shell hommies jumpToPending
```

| Method | Effect | Returns |
| --- | --- | --- |
| `jumpToPending` | Opens the card on the oldest waiting permission or question, else the oldest turn end | the item kind, or `none` |
| `toggle` / `open` / `close` | Opens or closes the card | `open`, `closed`, or `unavailable` |
| `focusTerminal` | Focuses the terminal of the session waiting on you, else the newest busy one | `ok` or `none` |
| `toggleSounds` | Turns sounds on or off | `on` or `off` |
| `toggleNotifications` | Turns desktop notifications on or off | `on` or `off` |
| `outfit <name>` | Dresses Hommie: `auto`, `none`, or an outfit below | what he wears now, or `none` |
| `emote <name>` | Plays `greet`, `celebrate`, `dizzy`, `wink`, `yawn`, or `look` | `ok` |

A card opened by a shortcut takes the keyboard right away, so the keys below
work without a click. The IPC actions drive the floating card; the bar
panel's keys work the same once it is open.

### In the panel

| Key | Session list | Open session |
| --- | --- | --- |
| `↑` `↓` (`k` `j`) | Move the selection | — |
| `←` `→` (`h` `l`) | Previous / next agent tab | `←` goes back to the list |
| `Enter` | Open the selected session | Submit the question's answers |
| `1`–`9` | Open the session at that position | Pick that option of the current question |
| `a` / `d` / `A` | — | Allow / Deny / Always allow a permission (`A` only when offered) |
| `x` | — | Dismiss a finished or waiting item |
| `t` | Go to the selected session's terminal | Go to its terminal |
| `Esc` | Close | Back to the list |

Once a key is used, a hint line at the bottom lists the keys that do
something right now. Questions answered in the agent's CLI (the "Claude CLI"
answer surface) stay read-only here too.

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
