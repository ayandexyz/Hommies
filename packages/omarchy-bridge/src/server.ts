import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { ApprovalRequestId, ThreadId } from "./localContracts.js";
import type {
  BridgePreferencesInput,
  BridgeServerOptions,
  ClaudePermissionHookInput,
  ClaudeTurnHookInput,
  PendingItem,
  PendingQuestionPrompt,
  PendingResponse,
  PendingResponseInput,
  QuestionAnswerSurface,
} from "./types.js";
import { detectReplyRequest, summarizeFinishedTurn } from "./stop-detection.js";

const responseTimeoutMs = 5 * 60 * 1000;
/** Turn-end items outlive hook timeouts, but not an abandoned session. */
const attentionTimeoutMs = 12 * 60 * 60 * 1000;

interface PendingPermission {
  readonly item: PendingItem;
  readonly hookInput: ClaudePermissionHookInput;
  readonly provider: "claude" | "codex";
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
  readonly streams: Set<ServerResponse>;
  questionAnswerSurface: QuestionAnswerSurface;
}

interface PendingQuestion {
  readonly item: PendingItem;
  readonly input: ClaudeQuestionHookInput;
  readonly answerSurface: QuestionAnswerSurface;
  readonly resolve?: (answers: Readonly<Record<string, unknown>> | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingAttention {
  readonly item: PendingItem;
  readonly cwd: string | undefined;
  readonly sessionTitle: string | undefined;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Starts the local daemon that Claude Code's hook and the QML client share. */
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
    streams: new Set(),
    questionAnswerSurface: "topbar",
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
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/question") {
      return await receiveClaudeQuestion(response, await readJson<ClaudeQuestionHookInput>(request), state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/question/resolved") {
      return resolveClaudeQuestion(response, await readJson<ClaudeQuestionHookInput>(request), state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/stop") {
      return receiveClaudeStop(response, await readJson<ClaudeTurnHookInput>(request), state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/resume") {
      return receiveClaudeResume(response, await readJson<ClaudeTurnHookInput>(request), state);
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (error: unknown) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : "bad request" });
  }
}

/**
 * Claude ended a turn. A question or decision becomes a notify-only
 * `attention` item; anything else becomes a `finished` status item.
 */
function receiveClaudeStop(response: ServerResponse, input: ClaudeTurnHookInput, state: BridgeState): void {
  if (input.hook_event_name !== "Stop" || typeof input.session_id !== "string" || typeof input.last_assistant_message !== "string") {
    throw new Error("invalid Claude Stop payload");
  }
  const question = detectReplyRequest(input.last_assistant_message);
  const kind = question === null ? "finished" : "attention";
  const summary = question ?? summarizeFinishedTurn(input.last_assistant_message);
  clearAttention(state, input.session_id);
  const id = ApprovalRequestId(randomUUID());
  const timer = setTimeout(() => {
    if (state.attention.get(input.session_id)?.item.id !== id) return;
    state.attention.delete(input.session_id);
    publish(state);
  }, attentionTimeoutMs);
  state.attention.set(input.session_id, {
    item: { id, threadId: ThreadId(input.session_id), provider: "claude", kind, summary, createdAt: new Date().toISOString() },
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    sessionTitle: typeof input.session_title === "string" && input.session_title.length > 0 ? input.session_title : undefined,
    timer,
  });
  publish(state);
  return sendJson(response, 200, { ok: true, attention: kind === "attention" });
}

/** The user replied or the session ended, so Claude is no longer waiting. */
function receiveClaudeResume(response: ServerResponse, input: ClaudeTurnHookInput, state: BridgeState): void {
  if ((input.hook_event_name !== "UserPromptSubmit" && input.hook_event_name !== "SessionEnd") || typeof input.session_id !== "string") {
    throw new Error("invalid Claude resume payload");
  }
  if (clearAttention(state, input.session_id)) publish(state);
  return sendJson(response, 200, { ok: true });
}

function clearAttention(state: BridgeState, sessionId: string): boolean {
  const existing = state.attention.get(sessionId);
  if (!existing) return false;
  clearTimeout(existing.timer);
  state.attention.delete(sessionId);
  return true;
}

async function receiveClaudeQuestion(response: ServerResponse, input: ClaudeQuestionHookInput, state: BridgeState): Promise<void> {
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
    // A new tool call means Claude is working again in this session.
    clearAttention(state, input.session_id);
    const id = ApprovalRequestId(questionKey(input.session_id, input.tool_use_id));
    const questions = parseQuestions(input.tool_input);
    const item: PendingItem = {
      id, threadId: ThreadId(input.session_id), provider: "claude", kind: "question",
      summary: questions[0]?.question ?? "Claude needs your input",
      createdAt: new Date().toISOString(), questions,
      answerSurface: state.questionAnswerSurface,
    };
    const previous = state.questions.get(String(id));
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve?.(null);
      state.questions.delete(String(id));
    }

    if (state.questionAnswerSurface === "cli") {
      const timer = setTimeout(() => {
        state.questions.delete(String(id));
        publish(state);
      }, responseTimeoutMs);
      state.questions.set(String(id), { item, input, answerSurface: "cli", timer });
      publish(state);
      // No hook decision: Claude continues into its native AskUserQuestion UI.
      return sendJson(response, 200, {});
    }

    const answers = await new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
      const timer = setTimeout(() => { state.questions.delete(String(id)); publish(state); resolve(null); }, responseTimeoutMs);
      const entry: PendingQuestion = { item, input, answerSurface: "topbar", resolve, timer };
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
    return sendJson(response, 200, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, answers } } });
  } else throw new Error("invalid Claude question hook payload");
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
  if (input.questionAnswerSurface !== "topbar" && input.questionAnswerSurface !== "cli") {
    return sendJson(response, 400, { error: "questionAnswerSurface must be topbar or cli" });
  }
  state.questionAnswerSurface = input.questionAnswerSurface;
  return sendJson(response, 200, { ok: true, questionAnswerSurface: state.questionAnswerSurface });
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

async function receivePermission(response: ServerResponse, input: ClaudePermissionHookInput, provider: "claude" | "codex", state: BridgeState): Promise<void> {
  if (!isClaudePermissionInput(input)) throw new Error("invalid Claude PermissionRequest payload");
  if (provider === "claude") clearAttention(state, input.session_id);
  const id = ApprovalRequestId(randomUUID());
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
      return sendJson(response, 409, { error: "this question must be answered in Claude CLI" });
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
    add(item, provider === "codex" ? "Codex" : "Claude Code", hookInput.cwd, hookInput.session_title);
  }
  for (const { item, input } of state.questions.values()) add(item, "Claude Code", input.cwd, input.session_title);
  for (const { item, cwd, sessionTitle } of state.attention.values()) add(item, "Claude Code", cwd, sessionTitle);
  let waiting = 0;
  for (const { item } of state.attention.values()) if (item.kind === "attention") waiting++;
  return { totalCount: state.pending.size + state.questions.size + waiting, threads: [...threads.values()] };
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

function describeTool(toolName: string, toolInput: Record<string, unknown>): string {
  const detail = typeof toolInput.command === "string" ? toolInput.command : typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.description === "string" ? toolInput.description : "requires your approval";
  const summary = `${toolName}: ${detail}`;
  return summary.length > 320 ? `${summary.slice(0, 317)}...` : summary;
}
