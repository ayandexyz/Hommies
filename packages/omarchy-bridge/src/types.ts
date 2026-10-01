import type { ApprovalRequestId, ProviderDriverKind, ThreadId } from "./localContracts.js";
import type { FocusWindow } from "./focus.js";
import type { BridgeNotifier } from "./notifier.js";
import type { BridgeSoundPlayer } from "./sound.js";

/**
 * Options for `startBridgeServer`.
 *
 * `dataDir` is the on-disk location for the SQLite database, the projection
 * journal, and `port.json`. The bridge writes a single `port.json` file under
 * `dataDir` so the QML plugin can discover the chosen port without env vars.
 *
 * `port: 0` asks the OS for a free port — the bridge always does this in
 * production. Explicit ports are only useful for tests.
 */
export interface BridgeServerOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly host?: string;
  /**
   * Called once for every new pending item while desktop notifications are
   * enabled. `runtime.ts` passes a `notify-send` notifier; omit it to disable.
   */
  readonly notify?: BridgeNotifier;
  /** Focuses a session's terminal for `POST /v1/focus`. Defaults to `hyprctl`; tests pass a stub. */
  readonly focusWindow?: FocusWindow;
  /**
   * Returns the agents whose agent-fold hooks are out of date. Run at start
   * and every minute; `runtime.ts` passes `outdatedHookProviders`.
   */
  readonly checkHooks?: () => Promise<ReadonlyArray<string>>;
  /** Plays a sound for each new item while the `sounds` preference is on. `runtime.ts` passes `createSoundPlayer()`. */
  readonly playSound?: BridgeSoundPlayer;
}

/**
 * Optional fields every adapter request may carry so `POST /v1/focus` can find
 * the agent's terminal: the agent process and its ancestors (nearest first),
 * and the tmux pane when the agent runs inside tmux.
 */
export interface AgentProcessFields {
  readonly pids?: ReadonlyArray<number>;
  readonly tmux_pane?: string;
  readonly tmux_socket?: string;
}

/** Body for `POST /v1/focus`. */
export interface FocusInput {
  readonly threadId: ThreadId;
}

/**
 * One pending item in `GET /v1/pending`.
 *
 * `kind` discriminates between the trackable event types:
 * - `question`: a `user-input.requested` activity that has not been resolved
 * - `permission`: an `approval.requested` activity that has not been resolved
 * - `attention`: the agent ended its turn with a plain-text question or
 *   decision. Notify-only: it is answered in the agent's own terminal and can
 *   be dismissed with any `decision` on `POST /v1/respond`.
 * - `finished`: the agent ended its turn without asking anything. Counted so
 *   the bell notifies; dismissed like `attention`.
 *
 * v2 will add `plan`, `session-error`, and `signed-out` to this union.
 */
export type PendingItemKind = "question" | "permission" | "attention" | "finished";
export type QuestionAnswerSurface = "topbar" | "cli";

export interface PendingQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface PendingQuestionPrompt {
  /** Claude Code expects answers to be keyed by the full question text. */
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<PendingQuestionOption>;
  readonly multiSelect: boolean;
}

export interface PendingItem {
  readonly id: ApprovalRequestId;
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly kind: PendingItemKind;
  readonly summary: string;
  readonly createdAt: string;
  /** Present for Claude AskUserQuestion, OpenCode, and Omacode question items. Optional for HTTP compatibility. */
  readonly questions?: ReadonlyArray<PendingQuestionPrompt>;
  /** The surface that owns the response; the other surface is display-only. */
  readonly answerSurface?: QuestionAnswerSurface;
  /**
   * Set on an `attention` item when the turn ended on an error instead of a
   * reply. Optional, so older clients show it as a plain attention item.
   */
  readonly failure?: SessionFailureKind;
  /**
   * Set on a `permission` item when `acceptAlways` would also stop the agent
   * asking again: Claude with permission suggestions, and OpenCode.
   */
  readonly canAcceptAlways?: boolean;
}

/** `ratelimit` covers usage limits and an overloaded API; anything else is `error`. */
export type SessionFailureKind = "error" | "ratelimit";

/**
 * The aggregate response shape for `GET /v1/pending`. Threads group items so
 * the QML panel can render one row per thread with the items underneath.
 */
export interface PendingResponse {
  readonly totalCount: number;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    /** Claude's `/resume` title for the session, when the transcript has one. */
    readonly sessionTitle?: string;
    /** Basename of the session's working directory. */
    readonly project?: string;
    readonly items: ReadonlyArray<PendingItem>;
  }>;
  /**
   * What each running session is doing right now, newest first. Not counted in
   * `totalCount`: nothing here needs an answer. Optional for HTTP compatibility.
   */
  readonly sessions?: ReadonlyArray<SessionActivity>;
  /** Agents whose hooks differ from what `agent-fold setup` writes. Absent when none are. */
  readonly hooksOutdated?: ReadonlyArray<string>;
}

/**
 * - `thinking`: the user sent a prompt and no tool has run yet
 * - `working`: the agent is running tools
 * - `idle`: the session started or its turn ended
 * - `error` / `ratelimit`: the turn ended on an API error or a usage limit;
 *   cleared by the next prompt or tool call
 */
export type SessionActivityState = "idle" | "thinking" | "working" | SessionFailureKind;

export interface SessionActivity {
  /** Same id as the session's thread in `threads`. */
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly state: SessionActivityState;
  /** Latest steps, oldest first: prompts as `> text`, tool calls as `Tool target`. */
  readonly steps: ReadonlyArray<string>;
  readonly sessionTitle?: string;
  /** Basename of the session's working directory. */
  readonly project?: string;
  readonly updatedAt: string;
  /** True when the adapter sent the agent's process ancestry, so `POST /v1/focus` can try it. */
  readonly focusable?: boolean;
}

/**
 * Body shape for `POST /v1/respond`.
 *
 * Either `decision` (for permissions) or `answers` (for questions) is set;
 * not both. The server validates this and returns 400 on mismatch.
 */
export interface PendingResponseInput {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  /**
   * `acceptAlways` allows and remembers the rule: Claude applies its own
   * permission suggestions, OpenCode replies `always`. Items without
   * `canAcceptAlways` treat it as `accept`.
   */
  readonly decision?: "accept" | "acceptAlways" | "decline" | "cancel";
  readonly answers?: Readonly<Record<string, unknown>>;
}

/** Any field may be sent alone; at least one is required. */
export interface BridgePreferencesInput {
  readonly questionAnswerSurface?: QuestionAnswerSurface;
  readonly desktopNotifications?: boolean;
  /** Play a sound for new items. Off by default. */
  readonly sounds?: boolean;
}

/** Payload sent by Claude Code's PermissionRequest hook. */
export interface ClaudePermissionHookInput extends AgentProcessFields {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly cwd: string;
  readonly hook_event_name?: "PermissionRequest";
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly permission_suggestions?: ReadonlyArray<unknown>;
  /** Added by agent-fold's hook adapter from the session transcript. */
  readonly session_title?: string;
  /**
   * OpenCode's own permission id (`per_...`). The OpenCode plugin sends it so
   * `/v1/providers/opencode/permission/resolved` can clear the item when the
   * request is answered in OpenCode's TUI.
   */
  readonly request_id?: string;
}

/**
 * A question from OpenCode's or Omacode's `question` tool, as sent by the
 * OpenCode plugin or Omacode's built-in agent-fold integration.
 */
export interface OpenCodeQuestionInput extends AgentProcessFields {
  readonly session_id: string;
  readonly cwd?: string;
  readonly session_title?: string;
  /** OpenCode's question id (`que_...`). */
  readonly request_id: string;
  readonly questions: ReadonlyArray<{
    readonly question: string;
    readonly header?: string;
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
    readonly multiple?: boolean;
  }>;
}

/** Sent by the OpenCode plugin or Omacode when a request was answered outside the bar. */
export interface OpenCodeResolvedInput {
  readonly session_id: string;
  readonly request_id: string;
}

/**
 * Body posted by the Claude and Codex hook adapters, the OpenCode plugin, and Omacode for Stop,
 * UserPromptSubmit, and SessionEnd. The adapter resolves
 * `last_assistant_message` from the transcript when the agent does not
 * supply it.
 */
export interface ClaudeTurnHookInput extends AgentProcessFields {
  readonly session_id: string;
  readonly cwd?: string;
  readonly hook_event_name: "Stop" | "UserPromptSubmit" | "SessionEnd";
  readonly last_assistant_message?: string;
  readonly session_title?: string;
  /** The submitted prompt on UserPromptSubmit; shown as an activity step. */
  readonly prompt?: string;
}

/**
 * Body for `POST /v1/providers/{provider}/failure`: the turn ended on an error
 * (Claude's `StopFailure` hook, OpenCode's `session.error`). Notify-only.
 * `error` uses Claude's names (`rate_limit`, `overloaded`, `billing_error`,
 * `authentication_failed`, `server_error`, `max_output_tokens`, ...); unknown
 * values are shown as a generic failure.
 */
export interface FailureHookInput extends AgentProcessFields {
  readonly session_id: string;
  readonly cwd?: string;
  readonly session_title?: string;
  readonly hook_event_name?: "StopFailure";
  readonly error: string;
  readonly error_details?: string;
}

/**
 * Body for `POST /v1/providers/{provider}/activity`. Notify-only: the bridge
 * answers right away and never returns a hook decision. Adapters send only
 * the short string fields of `tool_input` the step label needs.
 */
export interface ActivityHookInput extends AgentProcessFields {
  readonly session_id: string;
  readonly cwd?: string;
  readonly session_title?: string;
  readonly hook_event_name: "SessionStart" | "PreToolUse" | "PostToolUseFailure";
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, unknown>>;
}
