# Things to implement

Seven features worth adding to Hommies, roughly in priority order. The first
five extend the bridge and the panel. The last two add personality to Hommie.

Every change must follow the rules in `AGENTS.md` (the same ones listed at the
top of `docs/roadmap.md`):

- The `/v1/*` HTTP surface and the `port.json` format are a contract. Changes
  must be additions only (new routes, new optional fields). Anything breaking
  goes under `/v2/...`.
- Adapters must fail open. If the bridge isn't running, the agent falls back to
  its own prompt and is never blocked.
- The bridge stays loopback-only, with no telemetry.
- Update `packages/omarchy-bridge/README.md` whenever hook behavior changes.

---

## 1. Live edit stats (+N −M per file)

**Goal:** when an agent edits a file, show the file name and how many lines it
added and removed in the session's step feed, for example `Edit server.ts +12 −3`.

**Today:** `hook-common.ts` labels steps from a short list of `tool_input`
fields (`stepFields`), and file contents and diffs are kept out on purpose.

**Plan:**

- In the hook, compute the line counts from the tool input of `Edit`
  (`old_string` / `new_string`), `MultiEdit` (sum over `edits`) and `Write`
  (new line count; removals unknown unless the old file is read). For Codex
  `apply_patch`, count `+` / `-` lines in the patch.
- Send only the numbers: add optional `added` / `removed` fields to the step in
  the activity payload. The text itself never leaves the hook, so the privacy
  stance does not change.
- Render the counts next to the step in `Panel.qml` and `FloatingPanel.qml`,
  green for added and red for removed (`StatusPalette.qml`).

**Open question:** a full diff view (click a step to read the change) would mean
holding file content in bridge memory. Decide separately whether that is
acceptable. Counts only is the safe first step.

**Tests:** count helpers for each tool shape, including empty strings, trailing
newlines, and `MultiEdit` with several edits.

## 2. Full final message on finished turns

**Goal:** when a turn ends, let the user read the agent's last message in the
panel, not only the one-line summary.

**Today:** `stop-detection.ts` already reads the final assistant message (from
`last_assistant_message` or the transcript), and `sessionPreview()` in
`Panel.qml` shows `Finished: <summary>` on one line.

**Plan:**

- Add an optional, length-capped `message` field to `finished` and `attention`
  items (for example, the first 2 000 characters), next to the existing
  `summary`.
- In `Panel.qml` and `FloatingPanel.qml`, make the finished row expandable to
  show the message, with basic formatting (paragraphs, inline code, lists).
- Keep it out of `notify-send` arguments, following the existing rule in
  `notifier.ts` that private agent text stays out of the notification.

## 3. Gemini CLI and Antigravity support

**Goal:** sessions from Gemini CLI and Antigravity (`agy`) show up in the bar
like any other agent.

**Today:** `agent-hook.ts` (`hommies-hook --agent <name>`) already accepts
Claude-style hook JSON from any agent. These two agents use their own event
names, so they need a translation step.

**Event mapping:**

| Gemini CLI | Hommies event |
|---|---|
| `BeforeTool` | `PreToolUse` |
| `AfterTool` | `PostToolUse` |
| `BeforeAgent` | `UserPromptSubmit` |
| `AfterAgent` | `Stop` |

Do not hook Gemini's `AfterModel`: it fires on every response chunk.

| Antigravity | Hommies event |
|---|---|
| `PreInvocation` | `UserPromptSubmit` |
| `PreToolUse` | `PreToolUse` |
| `PostToolUse` | `PostToolUse` |
| `PostInvocation` | `PostToolUse` |
| `Stop` | `Stop` |

Antigravity also uses different field names: map `toolCall.name` to
`tool_name` and `conversationId` to `session_id`.

**Plan:**

- Add a translation layer in `agent-hook.ts`, chosen by `--agent gemini` or
  `--agent antigravity`, that rewrites the event name and fields before the
  existing reporting code runs.
- Add install steps to `setup.ts`: Gemini CLI hooks go in
  `~/.gemini/settings.json`; Antigravity hooks go in
  `~/.gemini/config/hooks.json` (timeouts in seconds).
- Add provider logos in `ProviderLogo.qml` and document both in the bridge
  README.
- Permission requests stay in the agent's own prompt (the generic hook never
  blocks), so fail-open holds.

## 4. Subagent steps

**Goal:** show when an agent starts and finishes a subagent, for example
`Subagent: explore the codebase`.

**Today:** `docs/roadmap.md` notes that `SubagentStart` and `SubagentStop` were
left unhooked to save a hook process per event. Subagent tool calls still show
up through `PreToolUse`.

**Plan:**

- These events fire once per subagent, not once per tool call, so the cost is
  small. Hook them in `claude-hook.ts` and treat them as activity events in
  `isActivityEvent()`.
- Add a step with the subagent's type or description, and keep the session in
  `working` until the matching `SubagentStop`.
- Add them to the Claude hook setup in `setup.ts` and the README.

## 5. Keyboard shortcuts

**Goal:** answer agents without the mouse.

**Shortcuts to offer:**

- Jump to the oldest waiting permission or question (opens the panel on it).
- Open or close the panel.
- Bring the waiting agent's terminal forward (uses `/v1/focus`).
- Mute or unmute sounds.
- In the open panel: Allow / Deny / Always keys on a permission card, number
  keys to pick a question option, arrows to move between sessions.

**Plan:**

- Global shortcuts belong to Hyprland, not the plugin: expose actions as
  `IpcHandler` functions in `Service.qml` (for example `openPanel`,
  `jumpToPending`, `toggleMute`) and document `bind` lines that call them
  through `omarchy-shell`.
- Panel shortcuts use QML `Keys` handlers while the panel has focus.
- Do not grab keys globally from QML, and do not start a second Quickshell
  process.

## 6. Hommie emotes and interactions

**Goal:** make Hommie feel alive between agent events.

**Ideas:**

- Reactions to clicks: a small bounce on a poke, and a dizzy state when poked
  many times in a row.
- A happy jump when a turn finishes.
- A short greeting animation when the shell starts.
- Eyes that follow the cursor while the pointer is near Hommie.
- Occasional idle emotes (yawn, wink, look around) on a random timer.

**Plan:**

- Add the new states and emotes to the state table in
  `characters/Hommie.qml`, next to the existing moods (`idle`, `ratelimit`,
  `error`, `finished`, `sleeping`, ...).
- Agent states always win over emotes: an emote must never hide a waiting
  permission or question.
- Extend `test-states.mjs` and `TEST_STATES_GUIDE.md` so every new state can be
  triggered and recorded.

## 7. Outfits

**Goal:** let the user dress Hommie up.

**Ideas:**

- A small set of accessories drawn in code (party hat, beanie, crown, glasses,
  scarf, ...), chosen from a right-click menu on Hommie.
- An automatic mode that picks a seasonal outfit (for example a pumpkin in
  late October, a Santa hat in December).

**Plan:**

- Draw outfits in QML (`Canvas` or `Shape`) as a layer that follows Hommie's
  head and eyes, so no image assets are needed.
- Save the choice in `floating.json` with the other preferences in
  `Service.qml`.
- Turn outfits off while Hommie is showing an alert state if they hurt
  readability.

---

## Out of scope

- Plan or quota usage from an online account: it needs network calls outside
  loopback.
- Phone sync or any cloud relay: breaks the loopback-only rule.
- Built-in chat with a model, file drop, and third-party service integrations:
  a different product.
