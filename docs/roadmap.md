# Roadmap: next features

Today Hommies only shows something when an agent needs you: a pending
permission, a question, or a turn that ended. The features below turn the bell
into a live status view of every running agent. They are listed in priority
order.

Every change must follow the rules in `AGENTS.md`:

- The `/v1/*` HTTP surface and the `port.json` format are a contract. Changes
  must be additions only (new routes, new optional fields). Anything breaking
  goes under `/v2/...`.
- Adapters must fail open. If the bridge isn't running, the agent falls back to
  its own prompt and is never blocked.
- The bridge stays loopback-only, with no telemetry.

---

## 1. Live session activity

**Status: done.** See "Live activity" in `packages/omarchy-bridge/README.md`.
What changed from the plan below: `PostToolUse` (other than for
AskUserQuestion) and the subagent events are not hooked, to save a hook
process per tool call. Subagent tool calls still show up through
`PreToolUse`. Omacode does not report activity yet; its route is ready.

**Goal:** show each session's state (idle, thinking, working) and a short feed
of its latest steps, such as `Edit server.ts` or `Bash pnpm test`, not only the
items that need an answer.

**Events to hook (Claude):** `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`,
`SessionEnd`. Codex, OpenCode and Omacode report the same transitions through
their own adapters.

**State per session:**

| Event | State | Step added |
|---|---|---|
| `SessionStart` | idle | — |
| `UserPromptSubmit` | thinking | prompt, first ~60 chars |
| `PreToolUse` | working | tool label + target (command, file basename, or query) |
| `PostToolUse` | working | — |
| `PostToolUseFailure` | working | "failed" marker |
| `SubagentStart` / `SubagentStop` | unchanged | "+ subagent" / "subagent done" |
| `Stop` | finished (existing item) | — |
| `SessionEnd` | removed | — |

Keep only the last ~20 steps per session in memory.

**Step labels:** map tool names to short verbs (`Read`, `Edit`, `Write`,
`Bash`, `Grep`, `WebFetch`, `Task`, …). For the target, use `command`
(first ~40 chars), then the basename of `file_path` or `path`, then `query`.

**Bridge:**

- New non-blocking route, for example
  `POST /v1/providers/{provider}/activity`. It replies `204` right away and
  never writes a hook decision.
- `/v1/pending` gets a new optional `sessions` array:
  `{ provider, sessionId, cwd, title, state, steps, updatedAt }`. Older plugin
  copies ignore it.
- Drop sessions that have been quiet for a while (for example 30 minutes) so
  crashed agents don't stay forever.

**Plugin:** the bar icon shows a working count or a pulse while any session is
working. The panel shows a section per provider with each session's state and
its latest steps.

**Cost and risk:** `PreToolUse`/`PostToolUse` start one hook process per tool
call. The hook must exit fast (short timeout, no stdout, never block) and skip
the POST if `port.json` is missing. `hommies setup` should add these hooks
with a short timeout, and the README must document them.

---

## 2. Error and rate-limit states

**Status: done.** See "Errors and rate limits" in
`packages/omarchy-bridge/README.md`. What changed from the plan below: Claude's
`Notification` hook has no rate-limit type, so both states come from
`StopFailure`'s `error` field instead of matching message text. Failures are
`attention` items with a new optional `failure` field (`error` or
`ratelimit`), so v1 clients still show and dismiss them. Codex has no failure
hook; OpenCode reports through `session.error`.

**Goal:** show when a session failed or hit a usage limit, not just "finished".

- `StopFailure` → session state `error`, plus an `attention`-style item with
  the failure detail.
- A `Notification` whose message mentions a rate or usage limit → state
  `ratelimit`.
- `types.ts` already plans `session-error` as a v2 item kind. Until v2, show
  these as a session `state` value (from feature 1) so v1 clients aren't
  affected.
- Desktop notification for errors, following the existing
  `desktopNotifications` preference.

---

## 3. Jump to the agent's terminal

**Status: done.** See "Jump to the terminal" in
`packages/omarchy-bridge/README.md`. The adapters send the ancestry with every
request rather than only once, so sessions started before the bridge are
still focusable. tmux is supported through the attached clients; the window is
focused by address, with a title match as the tie-breaker.

**Goal:** a "Go to terminal" button on each item and session that focuses the
exact Hyprland window running the agent.

1. The hook adapter collects its ancestor process IDs (walk
   `/proc/<pid>/stat` up from `process.ppid`) and sends them with each event.
2. The bridge keeps them per session.
3. On request (for example `POST /v1/focus` with `{ provider, sessionId }`),
   the bridge reads `hyprctl clients -j`, finds the first client whose `pid`
   is one of the ancestors, and runs
   `hyprctl dispatch focuswindow pid:<pid>`.
4. If no window matches, or `hyprctl` isn't available, return an error and
   hide the button.

Notes: terminals with one server process for many windows (kitty single
instance, foot server) can resolve to the wrong window. Checking the window
title against the cwd or session title helps there. tmux sessions need an
extra step to pick the right pane.

---

## 4. "Always allow" for permissions

**Status: done.** See "Always allow" in `packages/omarchy-bridge/README.md`.
Codex turned out to reject `updatedPermissions` in its hook output and has no
session-wide allow in the hook protocol, so the button is Claude- and
OpenCode-only. Items carry a new optional `canAcceptAlways` flag.

**Goal:** a third button next to Allow / Deny that approves the request and
stops the same rule from asking again.

- **Claude:** the `PermissionRequest` hook can return updated permission
  rules along with an allow decision. Check the current hook output format
  first, and use the suggestions Claude includes in the hook input rather
  than inventing rules.
- **Codex:** use its allow-for-this-session option.
- **OpenCode / Omacode:** map to their "always" reply if the protocol has one;
  otherwise hide the button for that provider.
- `POST /v1/respond`: add a new `decision` value (for example
  `acceptAlways`). Adapters that don't support it treat it as `accept`.

---

## 5. Generic agent route

**Status: done.** See "Custom agents" in `packages/omarchy-bridge/README.md`.
Custom agents use their own `/v1/agents/{name}/...` routes rather than a
`custom` provider, and are shown under an "Other" tab. The planned
`cursor`, `grok`, and `antigravity` names are reserved too.

**Goal:** let any tool that can run a command hook show up in the bar without
a dedicated adapter.

- `hommies-hook --agent <name>` (or a new `agent` field in the payload)
  tags events with an agent name.
- Validate the name against `^[a-z0-9-]{1,24}$`. Reserve the built-in
  provider names (`claude`, `codex`, `opencode`, `omacode`) so a custom agent
  can't impersonate them.
- Events with an invalid name are rejected and are never routed to a built-in
  provider.
- Activity, `Stop` and `SessionEnd` are supported at first. Blocking
  permissions for generic agents come later; until then the hook exits
  without a decision so the agent asks in its own terminal.
- Document the payload and a one-line `curl`/`echo` test in the bridge
  README.

---

## 6. Detect outdated hooks

**Status: done.** `hommies setup --check`, `hooksOutdated` on
`/v1/pending`, and a reminder in the panel. The check compares only
Hommies' own entries, so the user's hook order never causes a false alarm.

**Goal:** tell the user when their installed hooks are older than what this
version expects.

- `hommies setup --check` (or a status line in `setup --dry-run`) compares
  each provider's config with what setup would write: missing events, a
  permission hook timeout lower than the bridge's wait (~305s), or a command
  path that no longer exists.
- The bridge can run the same check at startup and expose a
  `hooksOutdated` flag on `/v1/pending`. The panel then shows
  "Hooks are out of date — run `hommies setup`".

---

## 7. Optional sounds

**Status: done.** See "Sounds" in `packages/omarchy-bridge/README.md`. The
bridge plays the sounds (so they follow the same new-item events as desktop
notifications), with a once-per-second limit. No volume setting yet; the
sounds are generated quiet and follow the system volume.

**Goal:** a short sound for new permissions or questions, errors, and
finished turns.

- Play with `pw-play` (fall back to `paplay`). If neither exists, stay silent.
- Use original sound files shipped with the plugin. Keep them small and
  licensed so they can be redistributed.
- Add a `sounds` preference to `/v1/preferences`, off by default, next to
  `desktopNotifications`. Add a volume setting if needed.
- No sounds for silent updates such as activity steps.
