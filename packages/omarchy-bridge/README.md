# @thisisayande/hommies

Localhost HTTP bridge that surfaces pending coding-agent questions and permissions
to the Hommies Omarchy plugin.

It is a self-contained server: the agent hooks, the OpenCode plugin, and the Omarchy
plugin all talk to it over loopback HTTP.

## API

```ts
import { startBridgeServer } from "@thisisayande/hommies";

await startBridgeServer({
  dataDir: "/home/me/.local/share/hommies",
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

Install the package, then let `hommies setup` (the alias from before the rename,
`agent-fold setup`, also works) register the hooks for the agents it finds (Claude Code in `~/.claude`, Codex in `~/.codex`, OpenCode in
`~/.config/opencode`, Gemini CLI in `~/.gemini`, Antigravity in `~/.gemini/config`,
Grok Build in `~/.grok`):

```sh
npm install -g @thisisayande/hommies
hommies setup --dry-run   # preview
hommies setup
```

In a terminal, setup first lists Claude Code, Codex, OpenCode, Gemini CLI,
Antigravity, and Grok Build with whether
each is installed, and lets you pick which to set up (arrows or `j`/`k` move,
space toggles, enter confirms). `--yes` sets up every installed agent without
asking, and `--only` names them; neither prompts, and nor does a non-terminal run.

Setup merges into the existing configs: your other hooks and plugins are kept,
re-running it replaces stale Hommies paths instead of duplicating them, and
every file it changes is first backed up as `<file>.hommies-backup-<time>`.
It respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `XDG_CONFIG_HOME`, writes
through symlinked dotfiles, and leaves unparseable files and OpenCode's
`opencode.jsonc` untouched (register those by hand as described below). Limit it
with `--only claude,codex,opencode,gemini,antigravity,grok`.

To see whether each agent's hooks match what this version of setup writes:

```sh
hommies setup --check
```

It reports each agent as up to date, out of date (missing events, an old
install path, or edited matchers or timeouts), without Hommies hooks, or not
installed, and exits `1` when any are out of date. Only Hommies' own
entries are compared, so your other hooks and their order do not matter. The
bridge runs the same check at start and every minute and lists out-of-date
agents in `hooksOutdated` on `/v1/pending`; the panel then shows a reminder to
re-run setup. Hooks you trimmed on purpose (for example, the activity hooks)
also count as out of date.

The same check lists every agent that has Hommies hooks, current or out of
date, in `hooksConnected`. The panel shows a tab only for those agents and for
any agent that has reported a session or item (Omacode, which needs no setup,
and custom agents). Until one qualifies, it shows all four built-in tabs.

To remove everything setup added:

```sh
hommies uninstall
npm uninstall -g @thisisayande/hommies
```

Run `hommies uninstall` first: npm no longer runs uninstall scripts, so removing
the package cannot remove the hooks. Each hook command is
`test -f <hook> && node <hook> || true`, so hooks left behind by a bare
`npm uninstall` do nothing. OpenCode's `plugin` entry is the exception; remove
it from `opencode.json` by hand.

### Renamed from agent-fold

Hommies was called agent-fold. The old names keep working, so existing hooks,
Omacode's built-in integration, and older plugin copies need no changes:

| Now | Before the rename (still accepted) |
| --- | --- |
| `hommies`, `hommies-bridge`, `hommies-hook`, `hommies-claude-hook`, `hommies-codex-hook` | the same commands named `agent-fold*` |
| `$XDG_DATA_HOME/hommies/` | `$XDG_DATA_HOME/agent-fold/`: the bridge also writes `port.json` there, and hooks look there when the new folder has none |
| `x-hommies-token` header | `x-agent-fold-token` |
| `HOMMIES_DATA_DIR`, `HOMMIES_AGENT` | `AGENT_FOLD_DATA_DIR`, `AGENT_FOLD_AGENT` |
| `<file>.hommies-backup-<time>` | `<file>.agent-fold-backup-<time>` (older backups keep their names) |

The plugin carries over Hommie's saved position and preferences from
`agent-fold/floating.json` the first time it starts without a `hommies` folder.

The sections below document the entries setup writes, for manual installs.

## Claude Code integration

The first provider integration uses Claude Code's `PermissionRequest` command
hook. It forwards the tool request to the local bridge and waits for an
**Accept**, **Always allow**, **Decline**, or **Cancel** response from Hommies. If the bridge
is not running, the hook produces no decision, so Claude Code keeps its normal
terminal permission prompt.

After installing `@thisisayande/hommies`, add this hook to `~/.claude/settings.json`
(replace the command with the absolute path to the installed package's
`dist/claude-hook.js`):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js" }] }],
    "PostToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js", "timeout": 5 }] }],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/@thisisayande/hommies/dist/claude-hook.js",
            "timeout": 305
          }
        ]
      }
    ]
  }
}
```

The bridge writes its loopback port, a per-start bearer token, its pid, and a
per-start `serverKey` to `$XDG_DATA_HOME/hommies/port.json` (or
`~/.local/share/hommies/port.json`, mode `0600`), and removes the file when it
stops. The hook reads that file; no network request leaves the machine.
Claude's hook payload and pending permissions stay in memory and are discarded
when the bridge exits.

### Bridge identity (stale ports)

A crash can leave `port.json` behind, and once the bridge has stopped its port
is free for any local user to bind. So every hook and the OpenCode plugin
check who they are talking to, and fail closed (no decision, the agent's own
prompt) when they cannot tell:

- After connecting and **before sending anything**, the hook looks up the
  server end of its own connection in `/proc/net/tcp` and requires it to be
  owned by the same uid. Another user's listener never sees the token or the
  hook payload.
- Each request carries a random `x-hommies-nonce`. The bridge answers with
  `x-hommies-proof`, an HMAC-SHA256 keyed with `serverKey` over
  `nonce + "\n" + status + "\n" + body`. `serverKey` is only ever in
  `port.json`, never on the wire, so a hook only uses a decision whose proof
  verifies. A forged or replayed permission grant is ignored.
- A `port.json` without `serverKey` (a bridge older than 0.1.6) is treated as
  no bridge.

Requests without a nonce are still served unsigned, so older clients keep
working.

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

Both kinds also carry the full final message in an optional `message` field
(Markdown, cut at a line break to 4000 characters), unless it adds nothing to
`summary`. The panel folds it under **Show full message**. The message is
never passed to desktop notifications.

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
| `SubagentStart` | working | `Subagent ` + the subagent's name, such as `Subagent Explore` |
| `SubagentStop` | working, or idle once the turn has ended and no subagent is left | `Subagent Explore finished` |
| `Stop` | idle, or working while a background subagent still runs | — |
| `SessionEnd` | removed | — |

Sessions keep their last 20 steps in memory. When an adapter sends the
process ancestry (see [Jump to the terminal](#jump-to-the-terminal)), the
bridge finds the agent's own process in it, skipping shell wrappers such as
`sh -c`. It checks that process every 5 seconds. Once the process exits, for
example because the agent was closed mid-turn, the session is dropped along
with any permission or question still pending for it. Without an ancestry, an
idle session with no events for 30 minutes is dropped (3 hours for a busy one,
since one tool call can run long), so a crashed agent does not stay listed.

The adapters send only the short string fields of `tool_input` the labels use
(`command`, `file_path`, `path`, `pattern`, `query`, `url`, `description`), never
file contents or diffs. The activity hooks run on every tool call, so they stay
cheap: no transcript reads, a 1-second request timeout, and no stdout. If the
bridge is not running they exit at once.

### Edit line counts

For file edits, the panel shows how many lines the edit adds and removes next
to the step, for example `Edit server.ts  +12 −3`. The adapter works the counts
out itself and sends only the two numbers as `edit: { "added": 12, "removed": 3 }`.
The edited text never reaches the bridge.

| Tool | How the lines are counted |
| --- | --- |
| `Edit` (Claude), `edit` (OpenCode), `replace` (Gemini CLI), `search_replace` (Grok Build), `replace_file_content` (Antigravity) | Line diff of the old and new text. With `replace_all`, multiplied by how often the old text appears in the file; with Gemini's `expected_replacements`, by that number. |
| `MultiEdit` (Claude), `multi_replace_file_content` (Antigravity) | Sum over its edits or chunks. |
| `Write` (Claude, OpenCode), `write_file` (Gemini CLI), `write_to_file` (Antigravity), `search_replace` with an empty `old_string` (Grok, creates a file) | Line diff of the file on disk and the new content; a new file is all additions. |
| `apply_patch` (Codex), `patch` (OpenCode) | `+` and `-` lines in the `*** Begin Patch` block, also when it runs through the shell tool. |

Antigravity reports a tool only after it ran, when the file already holds the
new content. Its replacements are still counted from their old and new text,
and a new file (`Overwrite: false`) is all additions, but an overwrite gets no
count, since its old content is gone.

Counts are taken on `PreToolUse` (Antigravity: after the tool ran), so they
describe the edit the agent asked for, even if it later fails. The adapter reads the target file only for `Write` and
`replace_all` edits, and skips files over 1 MB (a `Write` then counts its new
lines only). The diff matches lines like `git diff --numstat`. A very large
edit is counted roughly instead, so a hook never slows the agent down.

`GET /v1/pending` lists the activity in `sessions`, newest first:

```json
{
  "sessions": [{
    "threadId": "<session id>", "provider": "claude", "state": "working",
    "steps": ["> fix the build", "Bash pnpm build", "Edit server.ts"],
    "stepEdits": [null, null, { "added": 12, "removed": 3 }],
    "sessionTitle": "Fix the build", "project": "app", "updatedAt": "2026-10-01T12:00:00.000Z"
  }]
}
```

The field is optional, so older plugin copies ignore it. `stepEdits` is
index-aligned with `steps` (`null` for steps that are not edits) and is absent
when no listed step is an edit. Adapters post to
`/v1/providers/{claude,codex,opencode,omacode}/activity`:

```json
{ "hook_event_name": "PreToolUse", "session_id": "...", "cwd": "/w/app", "tool_name": "Bash", "tool_input": { "command": "pnpm build" } }
```

`hook_event_name` is `SessionStart`, `PreToolUse`, `PostToolUseFailure`,
`SubagentStart`, `SubagentStop`, or `StopCancelled` (a turn that ended without
completing: the session goes idle with an `(interrupted)` step and no
finished item). A `PreToolUse` that edits a file may add
`"edit": { "added": 12, "removed": 3 }`; the bridge ignores it unless both are
non-negative integers. The subagent events add `agent_id` (pairs the start
with its stop) and `agent_type` (the name shown in the step); the subagent's
reply is never sent. A subagent stopping never clears the session's turn-end
item, and a new prompt forgets any subagent whose stop never came (for
example after Esc). The
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
adapter. Point its hooks at `hommies-hook --agent <name>`; it reads
Claude-style hook JSON on stdin and reports to `/v1/agents/<name>/...`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "hommies-hook --agent my-tool", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "hommies-hook --agent my-tool", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "hommies-hook --agent my-tool", "timeout": 5 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "hommies-hook --agent my-tool", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "hommies-hook --agent my-tool", "timeout": 5 }] }]
  }
}
```

- The name comes from `--agent`, then `$HOMMIES_AGENT`, then an `agent`
  field in the payload. It must be 1-24 lowercase letters, digits, or hyphens,
  and not `claude`, `codex`, `opencode`, `omacode`, `cursor`, `grok`,
  `antigravity`, or `gemini`, so a custom agent cannot pose as a built-in one.
  (`gemini` became reserved when Gemini CLI got its own hook; a custom agent
  named `gemini` should switch to `hommies setup --only gemini`.) Invalid
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
  | hommies-hook --agent demo
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

`hommies-bridge` sends a desktop notification (via `notify-send`) for every
new item: permission requests (critical urgency), questions and waiting replies
(normal), and finished turns (low). A notification names only the agent and
the kind of item (for example "Claude" / "Permission needed"). It never
includes the question, command, file path, session title, or project folder,
because `notify-send` arguments are readable by other local users through
`/proc/<pid>/cmdline`. Open the bar to see the details. A session's newer
notification replaces its older one instead of stacking. Turn them off with the plugin's **Notify** toggle
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
structured `request_user_input` tool (offered only in Plan mode) arrives
through `PreToolUse` and is mirrored read-only in the bar whatever the answer
surface preference, because Codex hooks cannot supply its answers: answer it
in Codex. The mirror clears on the session's next tool call, `Stop`,
`UserPromptSubmit`, or `SessionEnd`. In Default mode Codex asks in plain text,
which the `Stop` detection covers.

Add these entries to `~/.codex/hooks.json`, preserving any existing hook
groups:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/codex-hook.js", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/codex-hook.js", "timeout": 5 }] }],
    "PermissionRequest": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/codex-hook.js", "timeout": 305 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/codex-hook.js", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/codex-hook.js", "timeout": 5 }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/to/@thisisayande/hommies/dist/codex-hook.js", "timeout": 5 }] }]
  }
}
```

Review and trust the hooks from Codex's `/hooks` screen before testing them.
If the bridge is unavailable, the adapter exits without a decision and Codex
keeps its native approval prompt; turn hooks never write to stdout.

## OpenCode integration

OpenCode has no command hooks, so Hommies ships an OpenCode server plugin,
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
  "plugin": ["file:///absolute/path/to/@thisisayande/hommies/dist/opencode-plugin.js"]
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

## Gemini CLI, Antigravity, and Grok Build

These agents get [live activity](#live-activity), turn ends (`finished` and
`attention` items), and, where the agent reports them, failed turns. Their
hooks cannot answer a permission or a question, so those stay in the agent's
own prompt, and the hooks never return a decision. Each one translates the
agent's payload to Claude's events and posts to
`/v1/providers/{gemini,antigravity,grok}/{activity,stop,resume,failure}`.
`hommies setup` registers them; to do it by hand, use the entries below with
the absolute path of the hook file in this package's `dist/`.

### Gemini CLI

`hommies-gemini-hook` (`dist/gemini-hook.js`), in `~/.gemini/settings.json`.
Timeouts are in milliseconds. Gemini CLI reads a JSON object from every hook's
stdout, so the hook always prints `{}` (no decision), even when the bridge is
not running.

| Gemini CLI event | Reported as |
| --- | --- |
| `SessionStart`, `SessionEnd` | the same |
| `BeforeTool` (matcher `*`) | `PreToolUse` step |
| `BeforeAgent` | `UserPromptSubmit` (thinking, with the prompt) |
| `AfterAgent` | `Stop`, with `prompt_response` as the final message |

`AfterTool` and the model events are not hooked: one step per tool call is
enough, and `AfterModel` fires on every streamed chunk. Gemini CLI has no
failure hook, so failed turns are not reported.

```json
{
  "hooks": {
    "BeforeTool": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "test -f /path/to/dist/gemini-hook.js && node /path/to/dist/gemini-hook.js || echo '{}'", "timeout": 5000 }] }]
  }
}
```

Register `SessionStart`, `BeforeAgent`, `AfterAgent`, and `SessionEnd` the same
way, without the matcher. Gemini CLI may ask you to approve changed hooks.

### Antigravity

`hommies-antigravity-hook` (`dist/antigravity-hook.js`), as a `hommies` entry in
`~/.gemini/config/hooks.json`, which is keyed by hook name. Antigravity's
payload does not name the event, so each command passes it as an argument.
Like Gemini CLI, Antigravity reads JSON from stdout and gets `{}`.

```json
{
  "hommies": {
    "enabled": true,
    "PreToolUse": [{ "matcher": "^ask_question$", "hooks": [{ "type": "command", "command": "test -f /path/to/dist/antigravity-hook.js && node /path/to/dist/antigravity-hook.js PreToolUse || echo '{}'", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "test -f /path/to/dist/antigravity-hook.js && node /path/to/dist/antigravity-hook.js PostToolUse || echo '{}'", "timeout": 5 }] }],
    "Stop": [{ "type": "command", "command": "test -f /path/to/dist/antigravity-hook.js && node /path/to/dist/antigravity-hook.js Stop || echo '{}'", "timeout": 5 }]
  }
}
```

- `PostToolUse` adds a step once the tool has run (`(failed)` when it sent an
  `error`).
- `PreToolUse` is hooked for `ask_question` only (timeout 305 s); every other
  tool keeps Antigravity's own permission prompt. Its hooks cannot rewrite the
  tool input, so an answer from the bar travels as a denial reason instead:
  - **Top bar** surface: the hook waits for the bar. Once you answer, it replies
    `{"decision":"deny","reason":"The user already answered this in Hommies …
    Which color? → Blue …"}`. Antigravity skips its own prompt and the model
    reads the answers from the reason. If the wait ends without an answer
    (Cancel, timeout, the bridge gone), it replies `{"decision":"allow"}` and
    Antigravity asks in its own UI.
  - **Claude CLI** surface: the question is mirrored read-only, the hook allows
    the call at once, and Antigravity's UI asks. It leaves the bar on
    Antigravity's next tool call or turn end.
- `Stop` ends the turn when `fullyIdle` is not `false`. A `Stop` with an
  `error` is reported as a failed turn.
- `PreInvocation` and `PostInvocation` run on every model call, not once per
  prompt, so they are not hooked. Antigravity sessions therefore never show
  **Thinking**.
- Its payloads carry no final message, so the `Stop` hook reads the last reply
  from the conversation's `transcriptPath` (`transcript_full.jsonl`). A reply
  that asks something becomes an `attention` item; without one, the turn end
  reads "Turn finished."
- Antigravity reads `hooks.json` when it starts: restart `agy` after setup.
- The session is the `conversationId`, and the project is the first of
  `workspacePaths`.

### Grok Build

`hommies-grok-hook` (`dist/grok-hook.js`), in a hook file of its own,
`~/.grok/hooks/hommies.json`, so your other Grok hook files are never touched.
It hooks `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUseFailure`, `Stop`, `StopFailure`, `StopCancelled`, and
`SessionEnd`. Grok sends every field twice, camelCase and Claude's snake_case,
and the event name differs between them: `hook_event_name` is Claude's
(`PreToolUse`) while `hookEventName` and `GROK_HOOK_EVENT` are Grok's own
snake_case (`pre_tool_use`); the hook reads the former and converts the
latter. The hook writes nothing to stdout, which Grok treats as allow-only
("not blocked"), so the tool call still goes through Grok's permission flow.

- Only a `Stop` with `reason: "end_turn"` ends a turn; Grok fires another at
  session end (`reason: "shutdown"`), which is ignored.
- `StopCancelled` (Ctrl+C, a declined permission) sets the session idle with an
  `(interrupted)` step and no finished item, using the `StopCancelled`
  activity event.
- Events from inside a subagent carry `subagentType` and are skipped, so a
  subagent never shows as its own session or ends the parent's turn.
- `ask_user_question` gets a second `PreToolUse` entry (matcher
  `^ask_user_question$`, timeout 305 s) that runs `grok-hook.js question`.
  Grok's hooks cannot fill in a tool's answers, so it works like Antigravity's:
  with the **Top bar** surface the hook waits for the bar, then denies the call
  with Grok's own answer wording as the reason (`User has answered your
  questions: "Which color?"="Blue". You can now continue …`), and the model
  carries on with it. With no answer, or the **Claude CLI** surface, the hook
  prints nothing (allow) and Grok asks in its own UI.

```json
{
  "hooks": {
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "test -f /path/to/dist/grok-hook.js && node /path/to/dist/grok-hook.js || true", "timeout": 5 }] }]
  }
}
```

Register the other events the same way. Grok reads hook files when it
starts: restart `grok` after setup. Grok Build also runs Claude Code's
hooks from `.claude/settings.json`. When `GROK_HOOK_EVENT` is set, the Claude
hook exits at once without output, so a Grok session is reported once, under
Grok, and never gets a Claude-style answer that Grok would ignore.

### Debugging an agent's hooks

Agents change their hook payloads between versions. To see exactly what the
Gemini CLI, Antigravity, or Grok Build hook receives, start the agent with
`HOMMIES_HOOK_LOG` set; each hook appends the raw payload and what it was
translated to:

```sh
HOMMIES_HOOK_LOG=/tmp/hommies-hooks.jsonl grok
```

The log holds prompts and code, so it is off unless you set the variable.

