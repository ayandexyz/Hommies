import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import { ApprovalRequestId, ThreadId } from "./localContracts.js";
import type { BridgeServerOptions, ClaudePermissionHookInput, PendingItem, PendingResponse, PendingResponseInput } from "./types.js";

const responseTimeoutMs = 5 * 60 * 1000;

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
  readonly streams: Set<ServerResponse>;
}

interface PendingQuestion {
  readonly item: PendingItem;
  readonly input: ClaudeQuestionHookInput;
  readonly resolve: (answers: Readonly<Record<string, unknown>> | null) => void;
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
  const state: BridgeState = { token: randomBytes(32).toString("base64url"), pending: new Map(), questions: new Map(), streams: new Set() };
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
      for (const question of state.questions.values()) { clearTimeout(question.timer); question.resolve(null); }
      state.pending.clear();
      state.questions.clear();
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
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/permission") {
      return await receivePermission(response, await readJson<ClaudePermissionHookInput>(request), "claude", state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/codex/permission") {
      return await receivePermission(response, await readJson<ClaudePermissionHookInput>(request), "codex", state);
    }
    if (request.method === "POST" && url.pathname === "/v1/providers/claude/question") {
      return await receiveClaudeQuestion(response, await readJson<ClaudeQuestionHookInput>(request), state);
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (error: unknown) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : "bad request" });
  }
}

async function receiveClaudeQuestion(response: ServerResponse, input: ClaudeQuestionHookInput, state: BridgeState): Promise<void> {
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion") {
    const id = ApprovalRequestId(questionKey(input.session_id, input.tool_use_id));
    const item: PendingItem = {
      id, threadId: ThreadId(input.session_id), provider: "claude", kind: "question",
      summary: describeQuestion(input.tool_input), createdAt: new Date().toISOString(),
    };
    const answers = await new Promise<Readonly<Record<string, unknown>> | null>((resolve) => {
      const timer = setTimeout(() => { state.questions.delete(String(id)); publish(state); resolve(null); }, responseTimeoutMs);
      state.questions.set(String(id), { item, input, resolve, timer });
      publish(state);
    });
    if (answers === null) return sendJson(response, 200, {});
    return sendJson(response, 200, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, answers } } });
  } else throw new Error("invalid Claude question hook payload");
}

function authorised(request: IncomingMessage, state: BridgeState): boolean {
  return request.headers["x-agent-fold-token"] === state.token;
}

async function receivePermission(response: ServerResponse, input: ClaudePermissionHookInput, provider: "claude" | "codex", state: BridgeState): Promise<void> {
  if (!isClaudePermissionInput(input)) throw new Error("invalid Claude PermissionRequest payload");
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
    publish(state);
  });
  if (result.behavior === "unchanged") return sendJson(response, 200, {});
  return sendJson(response, 200, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: result.behavior } } });
}

function respond(response: ServerResponse, input: PendingResponseInput, state: BridgeState): void {
  if (!input || typeof input.requestId !== "string" || typeof input.threadId !== "string") throw new Error("threadId and requestId are required");
  const pending = state.pending.get(input.requestId);
  const question = state.questions.get(input.requestId);
  if (question && question.item.threadId === input.threadId) {
    if (!input.answers || typeof input.answers !== "object") return sendJson(response, 400, { error: "a question answer is required" });
    const prompt = describeQuestion(question.input.tool_input);
    const answer = input.answers._answer;
    if (typeof answer !== "string" || answer.trim().length === 0) return sendJson(response, 400, { error: "answer must be a non-empty string" });
    state.questions.delete(input.requestId); clearTimeout(question.timer);
    question.resolve({ [prompt]: answer }); publish(state);
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
  const threads = new Map<string, { threadId: ReturnType<typeof ThreadId>; title: string; items: PendingItem[] }>();
  for (const { item, hookInput, provider } of state.pending.values()) {
    const label = provider === "codex" ? "Codex" : "Claude Code";
    const thread = threads.get(item.threadId) ?? { threadId: item.threadId, title: `${label} — ${basename(hookInput.cwd) || hookInput.cwd}`, items: [] };
    thread.items.push(item);
    threads.set(item.threadId, thread);
  }
  for (const { item } of state.questions.values()) {
    const thread = threads.get(item.threadId) ?? { threadId: item.threadId, title: "Claude Code", items: [] };
    thread.items.push(item);
    threads.set(item.threadId, thread);
  }
  return { totalCount: state.pending.size + state.questions.size, threads: [...threads.values()] };
}

interface ClaudeQuestionHookInput {
  readonly session_id: string;
  readonly hook_event_name: "PreToolUse" | "PostToolUse";
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly tool_input: Record<string, unknown>;
}

function questionKey(sessionId: string, toolUseId: string): string { return `${sessionId}:${toolUseId}`; }

function describeQuestion(toolInput: Record<string, unknown>): string {
  const questions = toolInput.questions;
  if (Array.isArray(questions) && questions[0] !== null && typeof questions[0] === "object") {
    const question = (questions[0] as Record<string, unknown>).question;
    if (typeof question === "string") return question.length > 320 ? `${question.slice(0, 317)}...` : question;
  }
  return "Claude needs your input";
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
