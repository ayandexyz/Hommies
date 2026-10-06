import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../dist/opencode-v2/server.js";
import { startBridgeServer } from "../dist/server.js";

const sessions = {
  root: { id: "ses_root", title: "Wire up OpenCode", location: { directory: "/home/me/proj" } },
  child: { id: "ses_child", title: "Child session - 2026-09-27T07:17:37.885Z", parentID: "ses_root", location: { directory: "/home/me/proj" } },
  fresh: { id: "ses_fresh", title: "New session - 2026-09-27T07:17:37.885Z", location: { directory: "/home/me/other" } },
};

test("the module's default export is a V2 plugin definition", () => {
  assert.equal(plugin.id, "hommies");
  assert.equal(typeof plugin.setup, "function");
});

test("a subagent's permission is listed under its root session and accepted from the bar", async () => {
  await withPlugin(async ({ request, emit, calls }) => {
    emit({ type: "permission.asked", data: {
      id: "per_1", sessionID: "ses_child", action: "bash", resources: ["rm -rf build"], metadata: { command: "rm -rf build" },
    } });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    const thread = snapshot.threads[0];
    assert.equal(thread.threadId, "ses_root");
    assert.equal(thread.title, "OpenCode — proj");
    assert.equal(thread.sessionTitle, "Wire up OpenCode");
    assert.deepEqual(
      [thread.items[0].id, thread.items[0].provider, thread.items[0].kind, thread.items[0].summary],
      ["per_1", "opencode", "permission", "bash: rm -rf build"],
    );

    await request("POST", "/v1/respond", { threadId: "ses_root", requestId: "per_1", decision: "accept" });
    await waitUntil(() => calls.permission.length === 1);
    assert.deepEqual(calls.permission[0], { sessionID: "ses_child", requestID: "per_1", decision: "once" });
  });
});

test("declining replies reject; a permission answered in the TUI is cleared without a reply", async () => {
  await withPlugin(async ({ request, emit, calls }) => {
    const ask = (id) => emit({ type: "permission.asked", data: {
      id, sessionID: "ses_root", action: "edit", resources: ["src/a.ts"], metadata: { filepath: "/home/me/proj/src/a.ts" },
    } });
    ask("per_decline");
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    assert.equal(snapshot.threads[0].items[0].summary, "edit: /home/me/proj/src/a.ts");
    await request("POST", "/v1/respond", { threadId: "ses_root", requestId: "per_decline", decision: "decline" });
    await waitUntil(() => calls.permission.length === 1);
    assert.equal(calls.permission[0].decision, "reject");

    ask("per_tui");
    await waitFor(request, (value) => value.totalCount === 1);
    emit({ type: "permission.replied", data: { sessionID: "ses_root", requestID: "per_tui", reply: "always" } });
    await waitFor(request, (value) => value.totalCount === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.permission.length, 1, "no reply is sent for a request OpenCode already answered");
  });
});

test("question forms are answered from the bar through the OpenCode service", async () => {
  await withPlugin(async ({ request, emit, formReplies }) => {
    emit({ type: "form.created", data: { form: {
      id: "frm_1", sessionID: "ses_root", title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
      fields: [
        { key: "q0", title: "Colors", description: "Which colors?", type: "multiselect", custom: true,
          options: [{ value: "Red", label: "Red", description: "r" }, { value: "Blue", label: "Blue", description: "b" }, { value: "Green", label: "Green" }] },
        { key: "q1", title: "Name", description: "Name?", type: "string", custom: true, options: [{ value: "Ada", label: "Ada" }] },
      ],
    } } });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    const item = snapshot.threads[0].items[0];
    assert.equal(item.kind, "question");
    assert.deepEqual(item.questions.map((question) => [question.header, question.multiSelect]), [["Colors", true], ["Name", false]]);

    await request("POST", "/v1/respond", {
      threadId: "ses_root", requestId: item.id, answers: { "Which colors?": "Blue, Green", "Name?": "Grace, Hopper" },
    });
    await waitUntil(() => formReplies.length === 1);
    assert.deepEqual(formReplies[0], {
      url: "/api/session/ses_root/form/frm_1/reply",
      authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      body: { answer: { q0: ["Blue", "Green"], q1: "Grace, Hopper" } },
    });
  });
});

test("forms that are not questions stay in OpenCode; answered or cancelled questions leave the bar", async () => {
  await withPlugin(async ({ request, emit, formReplies }) => {
    emit({ type: "form.created", data: { form: {
      id: "frm_auth", sessionID: "ses_root", title: "Sign in", fields: [{ key: "token", type: "string" }],
    } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await waitFor(request, () => true)).totalCount, 0);

    for (const type of ["form.replied", "form.cancelled"]) {
      emit({ type: "form.created", data: { form: {
        id: `frm_${type}`, sessionID: "ses_child", title: "Questions", metadata: { kind: "question" },
        fields: [{ key: "q0", title: "Go", description: "Go?", type: "string", options: [{ value: "Yes", label: "Yes" }] }],
      } } });
      await waitFor(request, (value) => value.totalCount === 1);
      emit({ type, data: { id: `frm_${type}`, sessionID: "ses_child", answer: { q0: "Yes" } } });
      await waitFor(request, (value) => value.totalCount === 0);
    }
    assert.equal(formReplies.length, 0);
  });
});

test("turn ends become attention or finished items; subagents, placeholders, interrupts, and failures are handled", async () => {
  const sent = [];
  await withPlugin(async ({ request, emit, messages, hooks }) => {
    messages.ses_root = "Two approaches.\n\nShould I use A or B?";
    messages.ses_child = "Subagent report.";
    messages.ses_fresh = "Done. All tests pass.";
    // OpenCode 2.0.24's real sequence: started → … → succeeded, and no session.idle.
    const turn = (sessionID, end, data = {}) => {
      emit({ type: "session.execution.started", data: { sessionID } });
      emit({ type: `session.execution.${end}`, data: { sessionID, ...data } });
    };

    turn("ses_child", "succeeded");
    turn("ses_root", "succeeded");
    turn("ses_fresh", "succeeded");
    const snapshot = await waitFor(request, (value) => value.totalCount === 2);
    const byThread = Object.fromEntries(snapshot.threads.map((thread) => [thread.threadId, thread]));
    assert.equal(byThread.ses_child, undefined, "a subagent finishing is not reported");
    assert.equal(byThread.ses_root.items[0].kind, "attention");
    assert.equal(byThread.ses_fresh.items[0].kind, "finished");
    assert.equal(byThread.ses_fresh.sessionTitle, undefined, "placeholder titles fall back to the folder");
    assert.equal(byThread.ses_fresh.title, "OpenCode — other");
    const finished = snapshot.sessions.find((session) => session.threadId === "ses_fresh");
    assert.notEqual(finished.state, "thinking", "a finished turn does not stay thinking");

    // Replying in OpenCode clears the session's item.
    await hooks.prompt({ sessionID: "ses_root" });
    await waitFor(request, (value) => value.totalCount === 1);

    // Esc: the interrupted turn is neither a question nor a finished report.
    await hooks.prompt({ sessionID: "ses_fresh" });
    turn("ses_fresh", "interrupted", { reason: "user" });
    // A later OpenCode that also sends session.idle must not report the turn again.
    emit({ type: "session.idle", data: { sessionID: "ses_fresh" } });
    await waitFor(request, (value) => value.totalCount === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const interrupted = await waitFor(request, () => true);
    assert.equal(interrupted.totalCount, 0);
    // Closing OpenCode mid-turn interrupts it: the row must go idle, not keep thinking.
    const fresh = interrupted.sessions.find((session) => session.threadId === "ses_fresh");
    assert.deepEqual([fresh.state, fresh.steps.at(-1)], ["idle", "(interrupted)"]);

    turn("ses_fresh", "failed", { error: { type: "api", message: "Too many requests", status: 429 } });
    const failed = await waitFor(request, (value) => value.totalCount === 1);
    assert.equal(failed.threads[0].threadId, "ses_fresh");

    emit({ type: "session.deleted", data: { sessionID: "ses_fresh" } });
    await waitFor(request, (value) => value.totalCount === 0);
  }, { notify: (notification) => sent.push(notification) });
  assert.deepEqual(sent.slice(0, 2).map((notification) => [notification.title, notification.urgency]).sort(), [
    ["OpenCode", "low"],
    ["OpenCode", "normal"],
  ]);
});

test("a prompt makes the root session think, named and with the prompt; subagent prompts are ignored", async () => {
  await withPlugin(async ({ request, hooks }) => {
    await hooks.prompt({ sessionID: "ses_child", prompt: { text: "subagent task" } });
    await hooks.prompt({ sessionID: "ses_root", prompt: { text: "list the files here" } });
    const snapshot = await waitFor(request, (value) => value.sessions.length === 1);
    const session = snapshot.sessions[0];
    assert.deepEqual([session.threadId, session.state, session.sessionTitle, session.project, session.steps],
      ["ses_root", "thinking", "Wire up OpenCode", "proj", ["> list the files here"]]);
  });
});

test("tool calls are reported as activity, except the question tool", async () => {
  await withPlugin(async ({ request, hooks }) => {
    await hooks["execute.before"]({ tool: "question", sessionID: "ses_root", input: {} });
    await hooks["execute.before"]({ tool: "bash", sessionID: "ses_child", input: { command: "pnpm test" } });
    const snapshot = await waitFor(request, (value) => value.sessions.length === 1);
    assert.deepEqual([snapshot.sessions[0].threadId, snapshot.sessions[0].steps], ["ses_root", ["bash pnpm test"]]);
  });
});

test("cleanup stops the event stream and disposes the hooks", async () => {
  const { ctx, state } = fakeContext();
  const cleanup = await plugin.setup(ctx);
  assert.equal(state.subscribed, true);
  await cleanup();
  assert.equal(state.signal.aborted, true);
  assert.equal(state.disposed, 2);
});

test("without a bridge or OpenCode service the plugin only stays out of the way", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-opencode-v2-empty-"));
  const previous = { data: process.env.HOMMIES_DATA_DIR, state: process.env.XDG_STATE_HOME };
  process.env.HOMMIES_DATA_DIR = dataDir;
  process.env.XDG_STATE_HOME = dataDir;
  const { ctx, emit, calls } = fakeContext();
  try {
    const cleanup = await plugin.setup(ctx);
    emit({ type: "permission.asked", data: { id: "per_x", sessionID: "ses_root", action: "bash" } });
    emit({ type: "session.idle", data: { sessionID: "ses_root" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.permission.length, 0);
    await cleanup();
  } finally {
    restoreEnv("HOMMIES_DATA_DIR", previous.data);
    restoreEnv("XDG_STATE_HOME", previous.state);
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** A fake of OpenCode V2's plugin context: an event stream, session/permission APIs, and hooks. */
function fakeContext(messages = {}) {
  const queue = [];
  let wake = null;
  const state = { subscribed: false, signal: null, disposed: 0 };
  const calls = { permission: [] };
  const hooks = {};
  const emit = (event) => {
    queue.push(event);
    wake?.();
  };
  const register = (name, callback) => {
    hooks[name] = callback;
    return Promise.resolve({ dispose: async () => { state.disposed++; } });
  };
  const ctx = {
    event: {
      subscribe: ({ signal } = {}) => {
        state.subscribed = true;
        state.signal = signal;
        return (async function* () {
          while (!signal?.aborted) {
            if (queue.length === 0) {
              await new Promise((resolve) => {
                wake = resolve;
                signal?.addEventListener("abort", resolve, { once: true });
              });
              wake = null;
              continue;
            }
            yield queue.shift();
          }
        })();
      },
    },
    session: {
      get: async ({ sessionID }) => {
        const session = Object.values(sessions).find((candidate) => candidate.id === sessionID);
        if (!session) throw new Error("not found");
        return session;
      },
      context: async ({ sessionID }) => {
        const text = messages[sessionID];
        return [
          { type: "user", id: "msg_u" },
          ...(text === undefined ? [] : [
            { type: "assistant", id: "msg_a1", content: [{ type: "tool", name: "read" }] },
            { type: "assistant", id: "msg_a2", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text }] },
          ]),
          { type: "idle", id: "msg_idle" },
        ];
      },
      hook: register,
    },
    permission: { reply: async (input) => { calls.permission.push(input); } },
    tool: { hook: register },
  };
  return { ctx, emit, calls, hooks, state };
}

/** Runs the plugin against a fake context, a live bridge, and a fake OpenCode service for form replies. */
async function withPlugin(run, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-opencode-v2-test-"));
  const server = await startBridgeServer({ dataDir, port: 0, ...options });
  const formReplies = [];
  const service = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      formReplies.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  await mkdir(join(dataDir, "opencode"), { recursive: true });
  await writeFile(join(dataDir, "opencode", "service.json"),
    JSON.stringify({ url: `http://127.0.0.1:${service.address().port}`, pid: process.pid, password: "secret" }));
  const previous = { data: process.env.HOMMIES_DATA_DIR, state: process.env.XDG_STATE_HOME };
  process.env.HOMMIES_DATA_DIR = dataDir;
  process.env.XDG_STATE_HOME = dataDir;
  const messages = {};
  const { ctx, emit, calls, hooks } = fakeContext(messages);
  let cleanup = null;
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-hommies-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    cleanup = await plugin.setup(ctx);
    await run({ request, emit, calls, hooks, messages, formReplies });
  } finally {
    await cleanup?.();
    restoreEnv("HOMMIES_DATA_DIR", previous.data);
    restoreEnv("XDG_STATE_HOME", previous.state);
    await new Promise((resolve) => service.close(resolve));
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitFor(request, predicate) {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await request("GET", "/v1/pending").then((response) => response.json());
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`pending never matched: ${JSON.stringify(last)}`);
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition never became true");
}
