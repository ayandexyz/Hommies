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
| `POST` | `/v1/preferences` | Select whether the top bar or Claude CLI owns question answers. |
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
Claude's report, but it is not counted in `totalCount` or the bell badge.

Both are notify-only: you reply in the terminal. They clear when you
submit a prompt in that session (`UserPromptSubmit`), when the session ends
(`SessionEnd`), when Claude starts another tool request in that session, when
you press **Dismiss**, or after 12 hours. These hooks never write to stdout and
never block Claude.

## Codex integration

Codex permission requests use the same local pending queue. Add this entry to
`~/.codex/hooks.json`, preserving any existing hook groups:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/@agent-fold/bridge/dist/codex-hook.js",
            "timeout": 305
          }
        ]
      }
    ]
  }
}
```

Review and trust the hook from Codex's `/hooks` screen before testing it. If
the bridge is unavailable, the adapter exits without a decision and Codex
keeps its native approval prompt.
