# @agent-fold/bridge

Localhost HTTP bridge that surfaces pending coding-agent questions and permissions
to the agent-fold Omarchy plugin.

This package embeds a thin slice of the T3 Code orchestration layer. It is *not* a
client of a separately running T3 Code server; it is the server.

## API

```ts
import { startBridgeServer } from "@agent-fold/bridge";

await startBridgeServer({
  dataDir: "/home/me/.local/share/agent-fold",
  port: 0, // 0 = pick a free port; written to dataDir/port.json
});
```

The server binds to `127.0.0.1` only. Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/pending` | Pending questions + permissions across all threads, grouped by thread. |
| `GET` | `/v1/stream` | SSE: emits deltas as the projection changes. |
| `POST` | `/v1/respond` | Dispatch a user response to an open question or permission request, or dismiss an `attention` item. |
| `POST` | `/v1/preferences` | Select whether the top bar or the agent's CLI owns question answers, and toggle desktop notifications. |
| `GET` | `/healthz` | Liveness probe. |

The HTTP surface is the contract with the QML plugin; do not break it without a
versioned path (`/v2/...`).

## Claude Code integration

The first provider integration uses Claude Code's `PermissionRequest` command
hook. It forwards the tool request to the local bridge and waits for an
**Accept**, **Decline**, or **Cancel** response from agent-fold. If the bridge
is not running, the hook produces no decision, so Claude Code keeps its normal
terminal permission prompt.

After installing `@agent-fold/bridge`, add this hook to `~/.claude/settings.json`
(replace the command with the absolute path to the installed package's
`dist/claude-hook.js`):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js" }] }],
    "PostToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js" }] }],
    "PostToolUseFailure": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js", "timeout": 5 }] }],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/@agent-fold/bridge/dist/claude-hook.js",
            "timeout": 305
          }
        ]
      }
    ]
  }
}
```

The bridge writes its loopback port and a per-start bearer token to
`$XDG_DATA_HOME/agent-fold/port.json` (or `~/.local/share/agent-fold/port.json`).
The hook reads that file; no network request leaves the machine. Claude's hook
payload and pending permissions stay in memory and are discarded when the
bridge exits.

Claude questions retain all headers, options, descriptions, and multi-select
metadata. In top-bar mode the hook waits for `/v1/respond`; in CLI mode it
returns immediately and keeps a read-only mirror until PostToolUse or
PostToolUseFailure closes the item.

### Plain-text questions (`Stop` hook)

Claude sometimes ends its turn with a question in prose ("Should I commit
this?") instead of calling `AskUserQuestion`. To Claude Code that looks the
same as a finished turn, so the `Stop` hook reads the final assistant message
(`last_assistant_message`, or the tail of `transcript_path`) and the bridge
checks its closing paragraph. If it ends with `?` or asks for a decision
("should I", "want me to", "which option", "let me know which", ...), an
`attention` item appears in the bar. Anything else becomes a `finished` status
item: the session is listed with a "Done" marker and the opening line of
Claude's report, and it counts toward `totalCount` so the bell notifies you.

Both are notify-only: you reply in the terminal. They clear when you
submit a prompt in that session (`UserPromptSubmit`), when the session ends
(`SessionEnd`), when Claude starts another tool request in that session, when
you press **Dismiss**, or after 12 hours. These hooks never write to stdout and
never block Claude.

## Desktop notifications

`agent-fold-bridge` sends a desktop notification (via `notify-send`) for every
new item: permission requests (critical urgency), questions and waiting replies
(normal), and finished turns (low). The title names the session by the agent's
session title or project folder, and a session's newer notification replaces its older
one instead of stacking. Turn them off with the plugin's **Notify** toggle
(`POST /v1/preferences` with `{"desktopNotifications": false}`), or start the
bridge with `--no-notify`. Library callers opt in by passing
`notify: createDesktopNotifier()` to `startBridgeServer`.

## Codex integration

Codex gets the same features as Claude Code, through Codex's own hooks:
permission requests from the bar, plain-text question and finished-turn
detection (`Stop`), clearing on reply or session end (`UserPromptSubmit`,
`SessionEnd`), session names from the `thread_name` in
`$CODEX_HOME/session_index.jsonl`, and desktop notifications. Codex's
structured `request_user_input` tool is only offered in Plan mode and is not
mirrored; in Default mode Codex asks in plain text, which the `Stop` detection
covers.

Add these entries to `~/.codex/hooks.json`, preserving any existing hook
groups:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/codex-hook.js", "timeout": 305 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/codex-hook.js", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/codex-hook.js", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@agent-fold/bridge/dist/codex-hook.js", "timeout": 5 }] }]
  }
}
```

Review and trust the hooks from Codex's `/hooks` screen before testing them.
If the bridge is unavailable, the adapter exits without a decision and Codex
keeps its native approval prompt; turn hooks never write to stdout.

## OpenCode integration

OpenCode has no command hooks, so agent-fold ships an OpenCode server plugin,
`dist/opencode-plugin.js`. It runs inside OpenCode and gives OpenCode the same
features as Claude Code:

- **Permissions** (`permission.asked`): Accept replies `once`, Decline replies
  `reject`, Cancel leaves the prompt to OpenCode.
- **Questions** from OpenCode's `question` tool, including multi-select and
  typed answers.
- **Turn ends** (`session.idle`): plain-text questions become `attention`
  items and anything else becomes `finished`, using the same classifier as the
  `Stop` hooks. Items clear when you send a message, delete the session, or
  interrupt the turn with Esc.
- **Session names** from OpenCode's generated session title.
- **Desktop notifications**.

OpenCode keeps showing its own prompt while the bar shows the request, and
whichever one you answer first wins. If you answer in OpenCode's TUI, the bar
item clears. Subagent (`task`) sessions are listed under the conversation that
started them, and a subagent finishing is not reported as a finished turn. In
**Claude CLI** answer mode, questions are mirrored read-only, as they are for
Claude.

Register the plugin in `~/.config/opencode/opencode.json`, keeping any
plugins you already have:

```json
{
  "plugin": ["file:///absolute/path/to/@agent-fold/bridge/dist/opencode-plugin.js"]
}
```

Restart OpenCode after changing the config. The plugin answers OpenCode through
the in-process client it is given, and it reaches the bridge only through
`port.json` on loopback. If the bridge is not running, the plugin does nothing,
and OpenCode behaves as it would without it.

## Omacode integration

Omacode (FreeCode) ships the integration itself, as a built-in of
`freecode serve` (`apps/core/src/hooks/builtin/agent-fold.ts`); there is
nothing to register. It posts to `/v1/providers/omacode/*` with the same
request-id protocol as the OpenCode plugin:

- **Permissions**: Accept answers `allow-once`, Decline answers `deny`, Cancel
  leaves the prompt to Omacode. Wider grants are only offered in Omacode's own
  prompt, where the rule they persist is visible.
- **Questions** from Omacode's `question` tool, including multi-select and
  typed answers.
- **Turn ends**: plain-text questions become `attention` items and anything
  else becomes `finished`. Items clear when the next turn starts or you
  interrupt the turn; a turn that failed is not reported.
- **Session names** from Omacode's session title, grouped by project folder.

Omacode keeps showing its own prompt, and whichever surface answers first wins.
It reads `port.json` on every report, so it follows a restarted bridge, and does
nothing when the bridge is not running. `FREECODE_AGENT_FOLD=0` turns it off.
A headless `freecode run` never reports.
