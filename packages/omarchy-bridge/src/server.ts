import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { ApprovalRequestId, ThreadId } from "./localContracts.js";
import type {
  ActivityHookInput,
  BridgePreferencesInput,
  FailureHookInput,
  BridgeServerOptions,
  ClaudePermissionHookInput,
  ClaudeTurnHookInput,
  OpenCodeQuestionInput,
  OpenCodeResolvedInput,
  PendingItem,
  PendingQuestionPrompt,
  PendingResponse,
  PendingResponseInput,
  QuestionAnswerSurface,
  SessionActivity,
  SessionActivityState,
  SessionFailureKind,
} from "./types.js";
import { detectReplyRequest, summarizeFinishedTurn } from "./stop-detection.js";
import type { BridgeNotifier } from "./notifier.js";

const responseTimeoutMs = 5 * 60 * 1000;
/** Turn-end items outlive hook timeouts, but not an abandoned session. */
const attentionTimeoutMs = 12 * 60 * 60 * 1000;
/** Sessions with no events for this long are dropped: the agent likely exited without SessionEnd. */
const idleSessionTimeoutMs = 30 * 60 * 1000;
/** A busy session can sit in one long tool call (a build, a test run), so it gets longer. */
const busySessionTimeoutMs = 3 * 60 * 60 * 1000;
const maxSessionSteps = 20;

interface PendingPermission {
  readonly item: PendingItem;
  readonly hookInput: ClaudePermissionHookInput;
  readonly provider: Provider;
  readonly resolve: (decision: ClaudeHookDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type ClaudeHookDecision = { readonly behavior: "allow" | "deny" | "unchanged" };

interface BridgeState {
  readonly token: string;
  readonly pending: Map<string, PendingPermission>;
  readonly questions: Map<string, PendingQuestion>;
  /** `attention` or `finished`, keyed by session id: only the latest turn end matters. */
  readonly attention: Map<string, PendingAttention>;
  /** Live activity, keyed by session id. */
  readonly sessions: Map<string, TrackedSession>;
  readonly streams: Set<ServerResponse>;
  readonly notify: BridgeNotifier | undefined;
  questionAnswerSurface: QuestionAnswerSurface;
  desktopNotifications: boolean;
}

interface PendingQuestion {
  readonly item: PendingItem;
  readonly provider: Provider;
  readonly input: ClaudeQuestionHookInput;
  readonly answerSurface: QuestionAnswerSurface;
  readonly resolve?: (answers: Readonly<Record<string, unknown>> | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type Provider = "claude" | "codex" | "opencode" | "omacode";

/**
 * Agents whose integration runs in-process (OpenCode's plugin, Omacode's
 * built-in) rather than as a blocking command hook. They send their own
 * request ids so an answer given in the agent's TUI can clear the bar, and
 * they take question answers as one label array per question.
 */
type RequestIdProvider = "opencode" | "omacode";
function hasRequestIds(provider: Provider): provider is RequestIdProvider {
  return provider === "opencode" || provider === "omacode";
}

/** `agent` names notifications and panel hints; `thread` prefixes `PendingResponse` thread titles. */
const providerLabels: Record<Provider, { readonly agent: string; readonly thread: string }> = {
  claude: { agent: "Claude", thread: "Claude Code" },
  codex: { agent: "Codex", thread: "Codex" },
  opencode: { agent: "OpenCode", thread: "OpenCode" },
  omacode: { agent: "Omacode", thread: "Omacode" },
};

function providerOf(item: PendingItem): Provider {
  switch (item.provider) {
    case "codex": return "codex";
    case "opencode": return "opencode";
    case "omacode": return "omacode";
    default: return "claude";
  }
}

interface TrackedSession {
  readonly provider: Provider;
  state: SessionActivityState;
  steps: string[];
  cwd: string | undefined;
  sessionTitle: string | undefined;
  updatedAt: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingAttention {
  readonly item: PendingItem;
  readonly cwd: string | undefined;
  readonly sessionTitle: string | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Starts the local daemon that the agent adapters and the QML client share. */
export async function startBridgeServer(
  options: BridgeServerOptions,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("agent-fold bridge may only bind to loopback addresses");
  }
  await mkdir(options.dataDir, { recursive: true });
  const state: BridgeState = {
    token: randomBytes(32).toString("base64url"),
    pending: new Map(),
    questions: new Map(),
    attention: new Map(),
    sessions: new Map(),
    streams: new Set(),
    notify: options.notify,
    questionAnswerSurface: "topbar",
    desktopNotifications: true,
  };
  const server = createServer((request, response) => { void handleRequest(request, response, state); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("agent-fold bridge did not receive a TCP address");
  await writeFile(
    join(options.dataDir, "port.json"),
    JSON.stringify({ port: address.port, token: state.token, version: 1 }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    port: address.port,
    close: async () => {
      for (const pending of state.pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ behavior: "unchanged" });
      }
      for (const question of state.questions.values()) {
        clearTimeout(question.timer);
        question.resolve?.(null);
      }
      for (const attention of state.attention.values()) clearTimeout(attention.timer);
      for (const session of state.sessions.values()) clearTimeout(session.timer);
      state.sessions.clear();
      state.pending.clear();
      state.questions.clear();
      state.attention.clear();
      for (const stream of state.streams) stream.end();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, state: BridgeState): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { ok: true });
    if (!authorised(request, state)) return sendJson(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && url.pathname === "/v1/pending") return sendJson(response, 200, snapshot(state));
    if (request.method === "GET" && url.pathname === "/v1/stream") return openStream(response, state);
    if (request.method === "POST" && url.pathname === "/v1/respond") return respond(response, await readJson<PendingResponseInput>(request), state);
    if (request.method === "POST" && url.pathname === "/v1/preferences") {
      return updatePreferences(response, await readJson<BridgePreferencesInput>(request), state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/permission") {
      return await receivePermission(response, await readJson<ClaudePermissionHookInput>(request), "claude", state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/codex/permission") {
      return await receivePermission(response, await readJson<ClaudePermissionHookInput>(request), "codex", state);
    }
    const inProcess = /^\/v1\/providers\/(opencode|omacode)\/(permission|question)(\/resolved)?$/.exec(url.pathname);
    if (request.method === "POST" && inProcess) {
      const provider = inProcess[1] as RequestIdProvider;
      const resolved = inProcess[3] !== undefined;
      if (inProcess[2] === "permission") {
        return resolved
          ? resolveRequestIdPermission(response, await readJson<OpenCodeResolvedInput>(request), provider, state)
          : await receivePermission(response, await readJson<ClaudePermissionHookInput>(request), provider, state);
      }
      return resolved
        ? resolveRequestIdQuestion(response, await readJson<OpenCodeResolvedInput>(request), state)
        : await receiveQuestion(response, openCodeQuestionInput(await readJson<OpenCodeQuestionInput>(request)), provider, state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/question") {
      return await receiveQuestion(response, await readJson<ClaudeQuestionHookInput>(request), "claude", state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/question/resolved") {
      return resolveClaudeQuestion(response, await readJson<ClaudeQuestionHookInput>(request), state);
    }
    const turn = /^\/v1\/providers\/(claude|codex|opencode|omacode)\/(stop|resume)$/.exec(url.pathname);
    if (request.method === "POST" && turn) {
      const provider = turn[1] as Provider;
      const input = await readJson<ClaudeTurnHookInput>(request);
      return turn[2] === "stop" ? receiveStop(response, input, provider, state) : receiveResume(response, input, provider, state);
    }
    const failure = /^\/v1\/providers\/(claude|codex|opencode|omacode)\/failure$/.exec(url.pathname);
    if (request.method === "POST" && failure) {
      return receiveFailure(response, await readJson<FailureHookInput>(request), failure[1] as Provider, state);
    }
    const activity = /^\/v1\/providers\/(claude|codex|opencode|omacode)\/activity$/.exec(url.pathname);
    if (request.method === "POST" && activity) {
      return receiveActivity(response, await readJson<ActivityHookInput>(request), activity[1] as Provider, state);
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (error: unknown) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : "bad request" });
  }
}

/**
 * An agent ended a turn. A question or decision becomes a notify-only
 * `attention` item; anything else becomes a `finished` status item.
 */
function receiveStop(response: ServerResponse, input: ClaudeTurnHookInput, provider: Provider, state: BridgeState): void {
  if (input.hook_event_name !== "Stop" || typeof input.session_id !== "string" || typeof input.last_assistant_message !== "string") {
    throw new Error("invalid Stop payload");
  }
  const question = detectReplyRequest(input.last_assistant_message);
  const kind = question === null ? "finished" : "attention";
  const summary = question ?? summarizeFinishedTurn(input.last_assistant_message);
  trackSession(state, provider, input.session_id, { cwd: input.cwd, sessionTitle: input.session_title, state: "idle" });
  setAttention(state, input.session_id, { provider, kind, summary }, input.cwd, input.session_title);
  return sendJson(response, 200, { ok: true, attention: kind === "attention" });
}

/** Replaces the session's turn-end item, publishes, and announces it. */
function setAttention(
  state: BridgeState,
  sessionId: string,
  fields: Pick<PendingItem, "provider" | "kind" | "summary" | "failure">,
  cwd: string | undefined,
  sessionTitle: string | undefined,
): void {
  clearAttention(state, sessionId);
  const id = ApprovalRequestId(randomUUID());
  const timer = setTimeout(() => {
    if (state.attention.get(sessionId)?.item.id !== id) return;
    state.attention.delete(sessionId);
    publish(state);
  }, attentionTimeoutMs);
  const item: PendingItem = { id, threadId: ThreadId(sessionId), ...fields, createdAt: new Date().toISOString() };
  state.attention.set(sessionId, {
    item,
    cwd: typeof cwd === "string" ? cwd : undefined,
    sessionTitle: typeof sessionTitle === "string" && sessionTitle.length > 0 ? sessionTitle : undefined,
    timer,
  });
  publish(state);
  announce(state, item, cwd, sessionTitle);
}

/** What each failure means for the user, by Claude's `StopFailure` error name. */
const failureLabels: Readonly<Record<string, { readonly kind: SessionFailureKind; readonly label: string }>> = {
  rate_limit: { kind: "ratelimit", label: "Rate limited \u2014 wait and retry" },
  overloaded: { kind: "ratelimit", label: "API overloaded \u2014 wait and retry" },
  billing_error: { kind: "error", label: "Billing error \u2014 check your plan or credits" },
  authentication_failed: { kind: "error", label: "Not signed in \u2014 log in again" },
  oauth_org_not_allowed: { kind: "error", label: "This organization is not allowed" },
  account_on_hold: { kind: "error", label: "Account on hold" },
  verification_required: { kind: "error", label: "Account verification required" },
  cloud_credential_error: { kind: "error", label: "Cloud credentials failed" },
  server_error: { kind: "error", label: "API unavailable \u2014 retry" },
  max_output_tokens: { kind: "error", label: "Hit the output token limit" },
  model_not_found: { kind: "error", label: "Model not found" },
  invalid_request: { kind: "error", label: "Request rejected by the API" },
};

/** The turn ended on an API error or a usage limit, so the agent stopped and needs you. */
function receiveFailure(response: ServerResponse, input: FailureHookInput, provider: Provider, state: BridgeState): void {
  if (!input || typeof input.session_id !== "string" || input.session_id.length === 0 || typeof input.error !== "string") {
    throw new Error("invalid failure payload");
  }
  const known = failureLabels[input.error];
  const kind = known?.kind ?? "error";
  const details = typeof input.error_details === "string" ? oneLine(input.error_details, 160) : "";
  const label = known?.label ?? "Turn failed";
  const summary = details && details !== label ? `${label}: ${details}` : label;
  trackSession(state, provider, input.session_id, { cwd: input.cwd, sessionTitle: input.session_title, state: kind });
  setAttention(state, input.session_id, { provider, kind: "attention", summary, failure: kind }, input.cwd, input.session_title);
  return sendJson(response, 200, { ok: true });
}

/** The user replied or the session ended, so the agent is no longer waiting. */
function receiveResume(response: ServerResponse, input: ClaudeTurnHookInput, provider: Provider, state: BridgeState): void {
  if ((input.hook_event_name !== "UserPromptSubmit" && input.hook_event_name !== "SessionEnd") || typeof input.session_id !== "string") {
    throw new Error("invalid resume payload");
  }
  clearAttention(state, input.session_id);
  if (input.hook_event_name === "SessionEnd") dropSession(state, input.session_id);
  else {
    const prompt = typeof input.prompt === "string" ? oneLine(input.prompt, 80) : "";
    trackSession(state, provider, input.session_id, {
      cwd: input.cwd, sessionTitle: input.session_title, state: "thinking", ...(prompt ? { step: `> ${prompt}` } : {}),
    });
  }
  publish(state);
  return sendJson(response, 200, { ok: true });
}

/** A session started, ran a tool, or a tool failed. Never blocks the agent. */
function receiveActivity(response: ServerResponse, input: ActivityHookInput, provider: Provider, state: BridgeState): void {
  if (!input || typeof input.session_id !== "string" || input.session_id.length === 0) throw new Error("invalid activity payload");
  const toolInput = input.tool_input !== null && typeof input.tool_input === "object" ? input.tool_input : {};
  const tool = typeof input.tool_name === "string" && input.tool_name.length > 0 ? input.tool_name : "Tool";
  switch (input.hook_event_name) {
    case "SessionStart":
      trackSession(state, provider, input.session_id, {
        cwd: input.cwd, sessionTitle: input.session_title, state: state.sessions.get(input.session_id)?.state ?? "idle",
      });
      break;
    case "PreToolUse":
      // A new tool call means the agent is no longer waiting on a turn-end reply.
      clearAttention(state, input.session_id);
      trackSession(state, provider, input.session_id, {
        cwd: input.cwd, sessionTitle: input.session_title, state: "working", step: describeStep(tool, toolInput),
      });
      break;
    case "PostToolUseFailure":
      trackSession(state, provider, input.session_id, {
        cwd: input.cwd, sessionTitle: input.session_title, state: "working", step: `${describeStep(tool, toolInput)} (failed)`,
      });
      break;
    default:
      throw new Error("invalid activity event");
  }
  publish(state);
  return sendJson(response, 200, { ok: true });
}

interface SessionUpdate {
  readonly cwd?: string | undefined;
  readonly sessionTitle?: string | undefined;
  readonly state?: SessionActivityState;
  readonly step?: string;
}

/** Creates or refreshes a session's activity and restarts its expiry timer. Callers publish. */
function trackSession(state: BridgeState, provider: Provider, sessionId: string, update: SessionUpdate): void {
  const existing = state.sessions.get(sessionId);
  if (existing) clearTimeout(existing.timer);
  const session: TrackedSession = existing ?? { provider, state: "idle", steps: [], cwd: undefined, sessionTitle: undefined, updatedAt: "" };
  if (typeof update.cwd === "string" && update.cwd.length > 0) session.cwd = update.cwd;
  if (typeof update.sessionTitle === "string" && update.sessionTitle.length > 0) session.sessionTitle = update.sessionTitle;
  if (update.state !== undefined) session.state = update.state;
  if (update.step !== undefined) {
    session.steps.push(update.step);
    if (session.steps.length > maxSessionSteps) session.steps.splice(0, session.steps.length - maxSessionSteps);
  }
  session.updatedAt = new Date().toISOString();
  const timer = setTimeout(() => {
    if (state.sessions.get(sessionId)?.timer !== timer) return;
    state.sessions.delete(sessionId);
    publish(state);
  }, session.state === "working" || session.state === "thinking" ? busySessionTimeoutMs : idleSessionTimeoutMs);
  session.timer = timer;
  state.sessions.set(sessionId, session);
}

function dropSession(state: BridgeState, sessionId: string): void {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  state.sessions.delete(sessionId);
}

function clearAttention(state: BridgeState, sessionId: string): boolean {
  const existing = state.attention.get(sessionId);
  if (!existing) return false;
  clearTimeout(existing.timer);
  state.attention.delete(sessionId);
  return true;
}

/**
 * Claude's AskUserQuestion (PreToolUse) and OpenCode's and Omacode's `question`
 * tools. Their questions arrive already converted to the AskUserQuestion shape.
 */
async function receiveQuestion(response: ServerResponse, input: ClaudeQuestionHookInput, provider: Provider, state: BridgeState): Promise<void> {
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
    // A new tool call means the agent is working again in this session.
    clearAttention(state, input.session_id);
    trackSession(state, provider, input.session_id, { cwd: input.cwd, sessionTitle: input.session_title });
    const id = ApprovalRequestId(questionKey(input.session_id, input.tool_use_id));
    const questions = parseQuestions(input.tool_input);
    const item: PendingItem = {
      id, threadId: ThreadId(input.session_id), provider, kind: "question",
      summary: questions[0]?.question ?? `${providerLabels[provider].agent} needs your input`,
      createdAt: new Date().toISOString(), questions,
      answerSurface: state.questionAnswerSurface,
    };
    dropQuestion(state, String(id));
    announce(state, item, input.cwd, input.session_title);

    if (state.questionAnswerSurface === "cli") {
      const timer = setTimeout(() => {
        state.questions.delete(String(id));
        publish(state);
      }, responseTimeoutMs);
      state.questions.set(String(id), { item, provider, input, answerSurface: "cli", timer });
      publish(state);
      // No answer: the agent's native question UI owns it.
      return sendJson(response, 200, {});
    }

    const answers = await new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
      const timer = setTimeout(() => { state.questions.delete(String(id)); publish(state); resolve(null); }, responseTimeoutMs);
      const entry: PendingQuestion = { item, provider, input, answerSurface: "topbar", resolve, timer };
      state.questions.set(String(id), entry);
      onHookDisconnect(response, () => {
        if (state.questions.get(String(id)) !== entry) return;
        clearTimeout(timer);
        state.questions.delete(String(id));
        publish(state);
        resolve(null);
      });
      publish(state);
    });
    if (answers === null) return sendJson(response, 200, {});
    if (hasRequestIds(provider)) return sendJson(response, 200, { answers: openCodeAnswers(questions, answers) });
    return sendJson(response, 200, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, answers } } });
  } else throw new Error("invalid Claude question hook payload");
}

/** Removes a question and releases a hook still waiting on it. */
function dropQuestion(state: BridgeState, id: string): boolean {
  const question = state.questions.get(id);
  if (!question) return false;
  clearTimeout(question.timer);
  state.questions.delete(id);
  question.resolve?.(null);
  return true;
}

function openCodeQuestionInput(input: OpenCodeQuestionInput): ClaudeQuestionHookInput {
  if (!input || typeof input.session_id !== "string" || typeof input.request_id !== "string" || !Array.isArray(input.questions)) {
    throw new Error("invalid question payload");
  }
  return {
    session_id: input.session_id,
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    ...(typeof input.session_title === "string" ? { session_title: input.session_title } : {}),
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: input.request_id,
    tool_input: { questions: input.questions.map((question) => ({ ...question, multiSelect: question.multiple === true })) },
  };
}

/**
 * OpenCode and Omacode want one array of labels per question, in order. The panel joins
 * multi-select picks with ", ", so split them back when every piece is an
 * option label; anything else is a custom answer.
 */
function openCodeAnswers(
  questions: ReadonlyArray<PendingQuestionPrompt>,
  answers: Readonly<Record<string, unknown>>,
): string[][] {
  return questions.map((question) => {
    const answer = String(answers[question.id] ?? "");
    if (!question.multiSelect) return [answer];
    const labels = new Set(question.options.map((option) => option.label));
    const pieces = answer.split(", ");
    return pieces.every((piece) => labels.has(piece)) ? pieces : [answer];
  });
}

function resolveRequestIdQuestion(response: ServerResponse, input: OpenCodeResolvedInput, state: BridgeState): void {
  if (!input || typeof input.session_id !== "string" || typeof input.request_id !== "string") {
    throw new Error("invalid question resolution payload");
  }
  if (dropQuestion(state, questionKey(input.session_id, input.request_id))) publish(state);
  return sendJson(response, 200, { ok: true });
}

function resolveRequestIdPermission(
  response: ServerResponse,
  input: OpenCodeResolvedInput,
  provider: RequestIdProvider,
  state: BridgeState,
): void {
  if (!input || typeof input.request_id !== "string") throw new Error("invalid permission resolution payload");
  const pending = state.pending.get(input.request_id);
  if (pending && pending.provider === provider) {
    clearTimeout(pending.timer);
    state.pending.delete(input.request_id);
    pending.resolve({ behavior: "unchanged" });
    publish(state);
  }
  return sendJson(response, 200, { ok: true });
}

function resolveClaudeQuestion(response: ServerResponse, input: ClaudeQuestionHookInput, state: BridgeState): void {
  if (
    (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") ||
    input.tool_name !== "AskUserQuestion"
  ) {
    throw new Error("invalid Claude question resolution payload");
  }
  const id = questionKey(input.session_id, input.tool_use_id);
  const pending = state.questions.get(id);
  if (pending) {
    clearTimeout(pending.timer);
    state.questions.delete(id);
    publish(state);
  }
  return sendJson(response, 200, { ok: true });
}

function updatePreferences(response: ServerResponse, input: BridgePreferencesInput, state: BridgeState): void {
  const surface = input?.questionAnswerSurface;
  const notifications = input?.desktopNotifications;
  if (surface === undefined && notifications === undefined) {
    return sendJson(response, 400, { error: "questionAnswerSurface or desktopNotifications is required" });
  }
  if (surface !== undefined && surface !== "topbar" && surface !== "cli") {
    return sendJson(response, 400, { error: "questionAnswerSurface must be topbar or cli" });
  }
  if (notifications !== undefined && typeof notifications !== "boolean") {
    return sendJson(response, 400, { error: "desktopNotifications must be a boolean" });
  }
  if (surface !== undefined) state.questionAnswerSurface = surface;
  if (notifications !== undefined) state.desktopNotifications = notifications;
  return sendJson(response, 200, {
    ok: true, questionAnswerSurface: state.questionAnswerSurface, desktopNotifications: state.desktopNotifications,
  });
}

const notificationHeadings: Record<PendingItem["kind"], string> = {
  permission: "Permission needed",
  question: "Question",
  attention: "Waiting for your reply",
  finished: "Finished",
};

const failureHeadings: Record<SessionFailureKind, string> = {
  error: "Stopped on an error",
  ratelimit: "Rate limited",
};

/** Sends one desktop notification per new item; a session's newer item replaces its older one. */
function announce(state: BridgeState, item: PendingItem | undefined, cwd: string | undefined, sessionTitle: string | undefined): void {
  if (!item || !state.notify || !state.desktopNotifications) return;
  const agent = providerLabels[providerOf(item)].agent;
  const name = sessionTitle || (cwd ? basename(cwd) || cwd : undefined);
  try {
    state.notify({
      key: item.threadId,
      title: name ? `${agent} · ${name}` : agent,
      body: `${item.failure === undefined ? notificationHeadings[item.kind] : failureHeadings[item.failure]}: ${item.summary}`,
      urgency: item.kind === "finished" ? "low" : item.kind === "permission" || item.failure === "error" ? "critical" : "normal",
    });
  } catch {
    // A broken notifier must not break the hook response.
  }
}

/**
 * Runs `onDisconnect` if the hook process goes away (Esc in Claude, killed
 * hook, timeout) before the bridge has answered it, so the bar does not keep
 * showing a request nobody is waiting on.
 */
function onHookDisconnect(response: ServerResponse, onDisconnect: () => void): void {
  response.once("close", () => {
    if (!response.writableFinished) onDisconnect();
  });
}

function authorised(request: IncomingMessage, state: BridgeState): boolean {
  return request.headers["x-agent-fold-token"] === state.token;
}

async function receivePermission(response: ServerResponse, input: ClaudePermissionHookInput, provider: Provider, state: BridgeState): Promise<void> {
  if (!isClaudePermissionInput(input)) throw new Error("invalid Claude PermissionRequest payload");
  // A new request means the agent is working again in this session.
  clearAttention(state, input.session_id);
  trackSession(state, provider, input.session_id, { cwd: input.cwd, sessionTitle: input.session_title });
  // OpenCode and Omacode ids let their integrations clear the item when the TUI answers first.
  const id = ApprovalRequestId(hasRequestIds(provider) && typeof input.request_id === "string" && input.request_id.length > 0
    ? input.request_id
    : randomUUID());
  const previous = state.pending.get(id);
  if (previous) {
    // The same request delivered twice: the newer connection owns it.
    clearTimeout(previous.timer);
    state.pending.delete(id);
    previous.resolve({ behavior: "unchanged" });
  }
  const item: PendingItem = {
    id, threadId: ThreadId(input.session_id), provider, kind: "permission",
    summary: describeTool(input.tool_name, input.tool_input), createdAt: new Date().toISOString(),
  };
  const result = await new Promise<ClaudeHookDecision>((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      publish(state);
      resolve({ behavior: "unchanged" });
    }, responseTimeoutMs);
    state.pending.set(id, { item, hookInput: input, provider, resolve, timer });
    onHookDisconnect(response, () => {
      if (!state.pending.delete(id)) return;
      clearTimeout(timer);
      publish(state);
      resolve({ behavior: "unchanged" });
    });
    publish(state);
    announce(state, item, input.cwd, input.session_title);
  });
  if (result.behavior === "unchanged") return sendJson(response, 200, {});
  return sendJson(response, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: result.behavior } } });
}

function respond(response: ServerResponse, input: PendingResponseInput, state: BridgeState): void {
  if (!input || typeof input.requestId !== "string" || typeof input.threadId !== "string") throw new Error("threadId and requestId are required");
  const attention = state.attention.get(input.threadId);
  if (attention && attention.item.id === input.requestId) {
    // Notify-only or status: any decision dismisses it; replies happen in the CLI.
    clearAttention(state, input.threadId);
    publish(state);
    return sendJson(response, 200, { ok: true });
  }
  const pending = state.pending.get(input.requestId);
  const question = state.questions.get(input.requestId);
  if (question && question.item.threadId === input.threadId) {
    if (question.answerSurface !== "topbar" || !question.resolve) {
      return sendJson(response, 409, { error: `this question must be answered in ${providerLabels[question.provider].agent}` });
    }
    if (!input.answers || typeof input.answers !== "object") return sendJson(response, 400, { error: "a question answer is required" });
    const answers = normalizeAnswers(question.item.questions ?? [], input.answers);
    if (answers === null) return sendJson(response, 400, { error: "every question requires a non-empty answer" });
    state.questions.delete(input.requestId); clearTimeout(question.timer);
    question.resolve(answers); publish(state);
    return sendJson(response, 200, { ok: true });
  }
  if (!pending || pending.item.threadId !== input.threadId) return sendJson(response, 404, { error: "pending request not found" });
  if (input.decision !== "accept" && input.decision !== "decline" && input.decision !== "cancel") {
    return sendJson(response, 400, { error: "permission decision must be accept, decline, or cancel" });
  }
  state.pending.delete(input.requestId);
  clearTimeout(pending.timer);
  pending.resolve({ behavior: input.decision === "accept" ? "allow" : input.decision === "decline" ? "deny" : "unchanged" });
  publish(state);
  return sendJson(response, 200, { ok: true });
}

function snapshot(state: BridgeState): PendingResponse {
  type Thread = PendingResponse["threads"][number] & { items: PendingItem[] };
  const threads = new Map<string, Thread>();
  const add = (item: PendingItem, label: string, cwd: string | undefined, sessionTitle: string | undefined): void => {
    const project = cwd ? basename(cwd) || cwd : undefined;
    const existing = threads.get(item.threadId);
    const thread: Thread = existing ?? {
      threadId: item.threadId, title: project ? `${label} — ${project}` : label,
      ...(project ? { project } : {}), items: [],
    };
    thread.items.push(item);
    // Later hooks carry the newer title; Claude refines it as the session grows.
    threads.set(item.threadId, sessionTitle ? { ...thread, sessionTitle } : thread);
  };
  for (const { item, hookInput, provider } of state.pending.values()) {
    add(item, providerLabels[provider].thread, hookInput.cwd, hookInput.session_title);
  }
  for (const { item, provider, input } of state.questions.values()) add(item, providerLabels[provider].thread, input.cwd, input.session_title);
  for (const { item, cwd, sessionTitle } of state.attention.values()) {
    add(item, providerLabels[providerOf(item)].thread, cwd, sessionTitle);
  }
  return {
    totalCount: state.pending.size + state.questions.size + state.attention.size,
    threads: [...threads.values()],
    sessions: sessionsSnapshot(state),
  };
}

function sessionsSnapshot(state: BridgeState): SessionActivity[] {
  return [...state.sessions.entries()]
    .map(([sessionId, session]): SessionActivity => {
      const project = session.cwd ? basename(session.cwd) || session.cwd : undefined;
      return {
        threadId: ThreadId(sessionId),
        provider: session.provider,
        state: session.state,
        steps: [...session.steps],
        ...(session.sessionTitle ? { sessionTitle: session.sessionTitle } : {}),
        ...(project ? { project } : {}),
        updatedAt: session.updatedAt,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

interface ClaudeQuestionHookInput {
  readonly session_id: string;
  readonly cwd?: string;
  readonly hook_event_name: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly tool_input: Record<string, unknown>;
  readonly session_title?: string;
}

function questionKey(sessionId: string, toolUseId: string): string { return `${sessionId}:${toolUseId}`; }

function parseQuestions(toolInput: Record<string, unknown>): PendingQuestionPrompt[] {
  const questions = toolInput.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((rawQuestion, index): PendingQuestionPrompt[] => {
    if (rawQuestion === null || typeof rawQuestion !== "object") return [];
    const value = rawQuestion as Record<string, unknown>;
    const question = typeof value.question === "string" && value.question.length > 0
      ? value.question
      : `Question ${index + 1}`;
    const rawOptions = Array.isArray(value.options) ? value.options : [];
    const options = rawOptions.flatMap((rawOption) => {
      if (rawOption === null || typeof rawOption !== "object") return [];
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string" || option.label.length === 0) return [];
      return [{
        label: option.label,
        ...(typeof option.description === "string" && option.description.length > 0
          ? { description: option.description }
          : {}),
      }];
    });
    return [{
      id: question,
      header: typeof value.header === "string" && value.header.length > 0
        ? value.header
        : `Question ${index + 1}`,
      question,
      options,
      multiSelect: value.multiSelect === true,
    }];
  });
}

function normalizeAnswers(
  questions: ReadonlyArray<PendingQuestionPrompt>,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  // Keep the original one-field HTTP contract working for installed clients.
  if (questions.length === 1 && typeof input._answer === "string" && input._answer.trim().length > 0) {
    return { [questions[0]?.id ?? "Question 1"]: input._answer.trim() };
  }
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const value = input[question.id];
    if (typeof value !== "string" || value.trim().length === 0) return null;
    answers[question.id] = value.trim();
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function publish(state: BridgeState): void {
  const data = `event: pending\ndata: ${JSON.stringify(snapshot(state))}\n\n`;
  for (const stream of state.streams) stream.write(data);
}

function openStream(response: ServerResponse, state: BridgeState): void {
  response.writeHead(200, { ...corsHeaders(), "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream" });
  state.streams.add(response);
  response.write(`event: pending\ndata: ${JSON.stringify(snapshot(state))}\n\n`);
  response.on("close", () => state.streams.delete(response));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...corsHeaders(), "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-agent-fold-token",
  };
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1024 * 1024) throw new Error("request body too large");
  }
  return JSON.parse(body) as T;
}

function isClaudePermissionInput(input: ClaudePermissionHookInput): boolean {
  return typeof input.session_id === "string" && typeof input.cwd === "string" && typeof input.tool_name === "string" && input.tool_input !== null && typeof input.tool_input === "object";
}

/** A short activity label such as `Edit server.ts` or `Bash pnpm test`. */
export function describeStep(toolName: string, toolInput: Readonly<Record<string, unknown>>): string {
  // `mcp__server__tool` reads better as `server · tool`.
  const tool = toolName.startsWith("mcp__") ? toolName.slice(5).split("__").join(" \u00b7 ") : toolName;
  const text = (key: string): string | null => {
    const value = toolInput[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  };
  const path = text("file_path") ?? text("notebook_path") ?? text("path");
  const target = text("command") ?? (path === null ? null : basename(path) || path)
    ?? text("pattern") ?? text("query") ?? text("url") ?? text("description");
  return target === null ? tool : `${tool} ${oneLine(target, 60)}`;
}

/** First line of `text`, whitespace collapsed, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const line = (text.split("\n").find((part) => part.trim().length > 0) ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function describeTool(toolName: string, toolInput: Record<string, unknown>): string {
  const detail = typeof toolInput.command === "string" ? toolInput.command : typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.description === "string" ? toolInput.description : "requires your approval";
  const summary = `${toolName}: ${detail}`;
  return summary.length > 320 ? `${summary.slice(0, 317)}...` : summary;
}
