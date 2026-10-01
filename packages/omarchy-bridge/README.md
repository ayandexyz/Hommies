# @thisisayande/agent-fold

Localhost HTTP bridge that surfaces pending coding-agent questions and permissions
to the agent-fold Omarchy plugin.

This package embeds a thin slice of the T3 Code orchestration layer. It is *not* a
client of a separately running T3 Code server; it is the server.

## API

```ts
import { startBridgeServer } from "@thisisayande/agent-fold";

await startBridgeServer({
  dataDir: "/home/me/.local/share/agent-fold",
  port: 0, // 0 = pick a free port; written to dataDir/port.json
});
```

The server binds to `127.0.0.1` only. Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/pending` | Pending questions + permissions across all threads, grouped by thread, plus each running session's live activity (`sessions`). |
| `GET` | `/v1/stream` | SSE: emits deltas as the projection changes. |
| `POST` | `/v1/respond` | Dispatch a user response to an open question or permission request, or dismiss an `attention` item. |
| `POST` | `/v1/providers/{provider}/failure` | Notify-only: a turn ended on an API error or a usage limit (see [Errors and rate limits](#errors-and-rate-limits)). |
| `POST` | `/v1/providers/{provider}/activity` | Notify-only: a session started, ran a tool, or a tool failed (see [Live activity](#live-activity)). |
| `POST` | `/v1/agents/{name}/{activity,stop,resume,failure}` | The same notify-only routes for a custom agent (see [Custom agents](#custom-agents)). |
| `POST` | `/v1/focus` | Focus the Hyprland window a session runs in (see [Jump to the terminal](#jump-to-the-terminal)). |
| `POST` | `/v1/preferences` | Select whether the top bar or the agent's CLI owns question answers, and toggle desktop notifications and sounds. |
| `GET` | `/healthz` | Liveness probe. |

The HTTP surface is the contract with the QML plugin; do not break it without a
versioned path (`/v2/...`).

## Setup

Install the package, then let `agent-fold setup` register the hooks for every
agent it finds (Claude Code in `~/.claude`, Codex in `~/.codex`, OpenCode in
`~/.config/opencode`):

```sh
npm install -g @thisisayande/agent-fold
agent-fold setup --dry-run   # preview
agent-fold setup
```

Setup merges into the existing configs: your other hooks and plugins are kept,
re-running it replaces stale agent-fold paths instead of duplicating them, and
every file it changes is first backed up as `<file>.agent-fold-backup-<time>`.
It respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `XDG_CONFIG_HOME`, writes
through symlinked dotfiles, and leaves unparseable files and OpenCode's
`opencode.jsonc` untouched (register those by hand as described below). Limit it
with `--only claude,codex,opencode`.

To see whether each agent's hooks match what this version of setup writes:

```sh
agent-fold setup --check
```

It reports each agent as up to date, out of date (missing events, an old
install path, or edited matchers or timeouts), without agent-fold hooks, or not
installed, and exits `1` when any are out of date. Only agent-fold's own
entries are compared, so your other hooks and their order do not matter. The
bridge runs the same check at start and every minute and lists out-of-date
agents in `hooksOutdated` on `/v1/pending`; the panel then shows a reminder to
re-run setup. Hooks you trimmed on purpose (for example, the activity hooks)
also count as out of date.

To remove everything setup added:

```sh
agent-fold uninstall
npm uninstall -g @thisisayande/agent-fold
```

The sections below document the entries setup writes, for manual installs.

## Claude Code integration

The first provider integration uses Claude Code's `PermissionRequest` command
hook. It forwards the tool request to the local bridge and waits for an
**Accept**, **Always allow**, **Decline**, or **Cancel** response from agent-fold. If the bridge
is not running, the hook produces no decision, so Claude Code keeps its normal
terminal permission prompt.

After installing `@thisisayande/agent-fold`, add this hook to `~/.claude/settings.json`
(replace the command with the absolute path to the installed package's
`dist/claude-hook.js`):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js" }] }],
    "PostToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js", "timeout": 5 }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js", "timeout": 5 }] }],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/claude-hook.js",
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

`PreToolUse` and `PostToolUseFailure` match every tool: the hook blocks only
for `AskUserQuestion` and reports every other tool call as
[live activity](#live-activity). If you only want questions and permissions,
set both matchers back to `AskUserQuestion` and drop `SessionStart`.

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

## Live activity

Besides the items that need you, the bar shows what each running session is
doing: **Thinking** after you send a prompt, **Working** while it runs tools,
and its latest steps, such as `> fix the build`, `Bash pnpm test`, or
`Edit server.ts` (`(failed)` is added when a tool fails). Activity never
counts toward the bell; a dot next to the bell means at least one session is
busy.

| Event | Session state | Step |
| --- | --- | --- |
| `SessionStart` | idle | — |
| `UserPromptSubmit` | thinking | `> ` + the prompt's first line |
| `PreToolUse` | working | tool + command, file name, pattern, query, or URL |
| `PostToolUseFailure` | working | same, with `(failed)` |
| `Stop` | idle | — |
| `SessionEnd` | removed | — |

Sessions keep their last 20 steps in memory. An idle session with no events
for 30 minutes is dropped (3 hours for a busy one, since one tool call can run
long), so a crashed agent does not stay listed.

The adapters send only the short string fields of `tool_input` the labels use
(`command`, `file_path`, `path`, `pattern`, `query`, `url`, `description`), never
file contents or diffs. The activity hooks run on every tool call, so they stay
cheap: no transcript reads, a 1-second request timeout, and no stdout. If the
bridge is not running they exit at once.

`GET /v1/pending` lists the activity in `sessions`, newest first:

```json
{
  "sessions": [{
    "threadId": "<session id>", "provider": "claude", "state": "working",
    "steps": ["> fix the build", "Bash pnpm build"],
    "sessionTitle": "Fix the build", "project": "app", "updatedAt": "2026-10-01T12:00:00.000Z"
  }]
}
```

The field is optional, so older plugin copies ignore it. Adapters post to
`/v1/providers/{claude,codex,opencode,omacode}/activity`:

```json
{ "hook_event_name": "PreToolUse", "session_id": "...", "cwd": "/w/app", "tool_name": "Bash", "tool_input": { "command": "pnpm build" } }
```

`hook_event_name` is `SessionStart`, `PreToolUse`, or `PostToolUseFailure`. The
prompt step comes from an optional `prompt` field on the existing
`UserPromptSubmit` body sent to `/v1/providers/{provider}/resume`.

## Errors and rate limits

When a turn ends on an API error instead of a reply, the session gets an
`attention` item with a `failure` field and its session state becomes
`error` or `ratelimit`. The bar shows it in red (error) or orange (rate limit),
it counts toward the bell, and it sends a desktop notification (critical for
errors, normal for rate limits). Like other attention items it is dismissed
with any decision on `/v1/respond`, and it clears when you send the next
prompt or the agent runs another tool.

| Error (`error`) | State | Shown as |
| --- | --- | --- |
| `rate_limit` | `ratelimit` | Rate limited — wait and retry |
| `overloaded` | `ratelimit` | API overloaded — wait and retry |
| `billing_error` | `error` | Billing error — check your plan or credits |
| `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error` | `error` | A sign-in or account message |
| `server_error` | `error` | API unavailable — retry |
| `max_output_tokens` | `error` | Hit the output token limit |
| `model_not_found`, `invalid_request` | `error` | Model not found / Request rejected by the API |
| anything else | `error` | Turn failed |

`error_details`, when sent, is added after the label. Sources:

- **Claude Code**: the `StopFailure` hook.
- **OpenCode**: `session.error` (not for Esc interrupts or subagents). A 429 is
  a rate limit, 529 overloaded, other 5xx a server error, `ProviderAuthError`
  a sign-in error, and `MessageOutputLengthError` the output token limit.
- **Codex** has no failure hook, so its failed turns are not reported.

Adapters post to `/v1/providers/{provider}/failure`:

```json
{ "hook_event_name": "StopFailure", "session_id": "...", "cwd": "/w/app", "error": "rate_limit", "error_details": "429 Too Many Requests" }
```

Older plugin copies ignore `failure` and show these as plain attention items.

## Custom agents

Any agent that can run a command hook can show up in the bar without its own
adapter. Point its hooks at `agent-fold-hook --agent <name>`; it reads
Claude-style hook JSON on stdin and reports to `/v1/agents/<name>/...`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "agent-fold-hook --agent my-tool", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "agent-fold-hook --agent my-tool", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "agent-fold-hook --agent my-tool", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "agent-fold-hook --agent my-tool", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "agent-fold-hook --agent my-tool", "timeout": 5 }] }]
  }
}
```

- The name comes from `--agent`, then `$AGENT_FOLD_AGENT`, then an `agent`
  field in the payload. It must be 1-24 lowercase letters, digits, or hyphens,
  and not `claude`, `codex`, `opencode`, `omacode`, `cursor`, `grok`, or
  `antigravity`, so a custom agent cannot pose as a built-in one. Invalid
  names are dropped by the hook and rejected by the bridge with `400`; such
  events never reach a built-in provider.
- Supported: live activity (`SessionStart`, `PreToolUse`,
  `PostToolUseFailure`), turn ends (`UserPromptSubmit`, `Stop`, `SessionEnd`),
  and failures (`StopFailure`). A `Stop` without `last_assistant_message`
  shows as "Turn finished." Pass `session_title` to name the session.
- **Permission requests are not answered from the bar yet**: the hook writes
  nothing, so the agent asks in its own terminal.
- Custom agents are listed under an **Other** tab, labelled with their name.

Quick test with the bridge running:

```sh
echo '{"hook_event_name":"UserPromptSubmit","session_id":"t1","cwd":"'"$PWD"'","prompt":"hello"}' \
  | agent-fold-hook --agent demo
```

## Always allow

Permission items show **Always** next to Allow when the agent can remember the
rule; the item then has `"canAcceptAlways": true`, and the panel sends
`"decision": "acceptAlways"` to `/v1/respond`.

- **Claude Code**: offered when the `PermissionRequest` payload has
  `permission_suggestions`. The bridge allows the request and returns those
  suggestions unchanged as `updatedPermissions`, the same rules Claude's own
  "don't ask again" option would save (Claude picks where they are stored).
  The bar never invents rules.
- **OpenCode**: the plugin replies `always` instead of `once`.
- **Codex** rejects `updatedPermissions` in its hook output, and **Omacode**
  only offers wider grants in its own prompt, so neither gets the button.

`acceptAlways` on an item without `canAcceptAlways` is treated as `accept`.

## Jump to the terminal

Opening a session in the panel shows **Go to terminal**, which focuses the
Hyprland window the agent runs in. Every adapter request carries the agent's
process ancestry, read from `/proc`, as `pids` (nearest first), and, inside
tmux, `tmux_pane` and `tmux_socket` from `$TMUX_PANE` and `$TMUX`.

`POST /v1/focus` with `{ "threadId": "<session id>" }` then:

1. For tmux sessions, selects the pane's window and pane, and adds the
   ancestry of every tmux client attached to that session.
2. Reads `hyprctl clients -j` and picks the window owned by the nearest
   ancestor. When one process owns several windows (kitty single instance,
   foot server), a window whose title contains the session title or project
   folder wins.
3. Focuses it by address: `hyprctl dispatch 'hl.dsp.focus({ window = "address:<address>" })'`
   on Hyprland 0.56+ (Lua dispatch), falling back to
   `hyprctl dispatch focuswindow address:<address>` on older versions.

It answers `404` when the session sent no ancestry or no window matched (for
example an agent over SSH, or a headless `opencode serve`). Sessions the bridge
can try are marked `"focusable": true` in `sessions`. The pids are validated
(positive integers, at most 64), the tmux values must look like tmux's own, and
commands run through `execFile` without a shell.

## Desktop notifications

`agent-fold-bridge` sends a desktop notification (via `notify-send`) for every
new item: permission requests (critical urgency), questions and waiting replies
(normal), and finished turns (low). The title names the session by the agent's
session title or project folder, and a session's newer notification replaces its older
one instead of stacking. Turn them off with the plugin's **Notify** toggle
(`POST /v1/preferences` with `{"desktopNotifications": false}`), or start the
bridge with `--no-notify`. Library callers opt in by passing
`notify: createDesktopNotifier()` to `startBridgeServer`.

## Sounds

The bridge can play a short chime for each new item: a rising pair for
permissions, questions, waiting replies, and rate limits; a lower falling pair
for failed turns; and a single soft note for finished turns. Sounds are **off
by default**; turn them on with the plugin's **Sound** toggle (or
`POST /v1/preferences` with `{"sounds": true}`). They follow new items only,
never activity steps, and a burst of items plays once per second at most.

Playback uses `pw-play`, falling back to `paplay`; with neither, the bridge
stays silent. The WAV files in `sounds/` are original to this repository and
generated by `scripts/make-sounds.mjs` (MIT, like the code). Library callers
opt in with `playSound: createSoundPlayer()`.

## Codex integration

Codex gets the same features as Claude Code, through Codex's own hooks:
permission requests from the bar, plain-text question and finished-turn
detection (`Stop`), clearing on reply or session end (`UserPromptSubmit`,
`SessionEnd`), session names from the `thread_name` in
`$CODEX_HOME/session_index.jsonl`, [live activity](#live-activity) from
`SessionStart` and `PreToolUse`, and desktop notifications. Codex's
structured `request_user_input` tool is only offered in Plan mode and is not
mirrored; in Default mode Codex asks in plain text, which the `Stop` detection
covers.

Add these entries to `~/.codex/hooks.json`, preserving any existing hook
groups:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/codex-hook.js", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/codex-hook.js", "timeout": 5 }] }],
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/codex-hook.js", "timeout": 305 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/codex-hook.js", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/codex-hook.js", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/agent-fold/dist/codex-hook.js", "timeout": 5 }] }]
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

- **Permissions** (`permission.asked`): Accept replies `once`, Always replies
  `always`, Decline replies `reject`, Cancel leaves the prompt to OpenCode.
- **Questions** from OpenCode's `question` tool, including multi-select and
  typed answers.
- **Turn ends** (`session.idle`): plain-text questions become `attention`
  items and anything else becomes `finished`, using the same classifier as the
  `Stop` hooks. Items clear when you send a message, delete the session, or
  interrupt the turn with Esc.
- **Session names** from OpenCode's generated session title.
- **Errors and rate limits** (`session.error`): a failed turn becomes a red
  or orange item instead of a finished one.
- **Live activity** (`tool.execute.before`): each tool call shows up as a
  step, with subagent tool calls listed under the conversation that started
  them.
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
  "plugin": ["file:///absolute/path/to/@thisisayande/agent-fold/dist/opencode-plugin.js"]
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

Omacode does not report [live activity](#live-activity) yet; the
`/v1/providers/omacode/activity` route is ready for it.

Omacode keeps showing its own prompt, and whichever surface answers first wins.
It reads `port.json` on every report, so it follows a restarted bridge, and does
nothing when the bridge is not running. `FREECODE_AGENT_FOLD=0` turns it off.
A headless `freecode run` never reports.
