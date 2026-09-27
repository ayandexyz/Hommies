import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as pluginModule from "../dist/opencode-plugin.js";
import { startBridgeServer } from "../dist/server.js";

const { AgentFoldOpenCode } = pluginModule;

const sessions = {
  root: { id: "ses_root", directory: "/home/me/proj", title: "Wire up OpenCode" },
  child: { id: "ses_child", directory: "/home/me/proj", title: "Child session - 2026-09-27T07:17:37.885Z", parentID: "ses_root" },
  fresh: { id: "ses_fresh", directory: "/home/me/other", title: "New session - 2026-09-27T07:17:37.885Z" },
};

test("the plugin module exports only the plugin", () => {
  // OpenCode calls every export of a plugin module as a plugin.
  assert.deepEqual(Object.keys(pluginModule), ["AgentFoldOpenCode"]);
});

test("a subagent's permission is listed under its root session and accepted from the bar", async () => {
  await withPlugin(async ({ request, plugin, replies }) => {
    await plugin.event({ event: { type: "permission.asked", properties: {
      id: "per_1", sessionID: "ses_child", permission: "bash", patterns: ["rm -rf build"],
      metadata: { command: "rm -rf build" }, always: ["rm *"],
    } } });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    const thread = snapshot.threads[0];
    assert.equal(thread.threadId, "ses_root");
    assert.equal(thread.title, "OpenCode — proj");
    assert.equal(thread.sessionTitle, "Wire up OpenCode");
    assert.deepEqual(
      [thread.items[0].id, thread.items[0].provider, thread.items[0].kind, thread.items[0].summary],
      ["per_1", "opencode", "permission", "bash: rm -rf build"],
    );

    const respond = await request("POST", "/v1/respond", { threadId: "ses_root", requestId: "per_1", decision: "accept" });
    assert.equal(respond.status, 200);
    await waitUntil(() => replies.length === 1);
    assert.deepEqual(replies[0], { url: "/permission/{requestID}/reply", path: { requestID: "per_1" }, body: { reply: "once" } });
  });
});

test("declining replies reject; a permission answered in the TUI is cleared without a reply", async () => {
  await withPlugin(async ({ request, plugin, replies }) => {
    const ask = (id) => plugin.event({ event: { type: "permission.asked", properties: {
      id, sessionID: "ses_root", permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "/home/me/proj/src/a.ts", diff: "x".repeat(10) },
    } } });
    await ask("per_decline");
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    assert.equal(snapshot.threads[0].items[0].summary, "edit: /home/me/proj/src/a.ts");
    await request("POST", "/v1/respond", { threadId: "ses_root", requestId: "per_decline", decision: "decline" });
    await waitUntil(() => replies.length === 1);
    assert.deepEqual(replies[0].body, { reply: "reject" });

    await ask("per_tui");
    await waitFor(request, (value) => value.totalCount === 1);
    await plugin.event({ event: { type: "permission.replied", properties: { sessionID: "ses_root", requestID: "per_tui", reply: "always" } } });
    await waitFor(request, (value) => value.totalCount === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replies.length, 1, "no reply is sent for a request OpenCode already answered");
  });
});

test("questions are answered from the bar with one label array per question", async () => {
  await withPlugin(async ({ request, plugin, replies }) => {
    await plugin.event({ event: { type: "question.asked", properties: {
      id: "que_1", sessionID: "ses_root",
      questions: [
        { question: "Which colors?", header: "Colors", multiple: true, options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }, { label: "Green", description: "g" }] },
        { question: "Name?", header: "Name", options: [{ label: "Ada", description: "" }] },
      ],
    } } });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    const item = snapshot.threads[0].items[0];
    assert.equal(item.kind, "question");
    assert.equal(item.provider, "opencode");
    assert.equal(item.answerSurface, "topbar");
    assert.deepEqual(item.questions.map((question) => [question.header, question.multiSelect]), [["Colors", true], ["Name", false]]);

    const respond = await request("POST", "/v1/respond", {
      threadId: "ses_root", requestId: item.id, answers: { "Which colors?": "Blue, Green", "Name?": "Grace, Hopper" },
    });
    assert.equal(respond.status, 200);
    await waitUntil(() => replies.length === 1);
    assert.deepEqual(replies[0], { url: "/question/{requestID}/reply", path: { requestID: "que_1" }, body: { answers: [["Blue", "Green"], ["Grace, Hopper"]] } });
  });
});

test("a question answered or dismissed in the TUI leaves the bar", async () => {
  await withPlugin(async ({ request, plugin, replies }) => {
    for (const type of ["question.replied", "question.rejected"]) {
      await plugin.event({ event: { type: "question.asked", properties: {
        id: `que_${type}`, sessionID: "ses_child", questions: [{ question: "Go?", header: "Go", options: [{ label: "Yes", description: "" }] }],
      } } });
      await waitFor(request, (value) => value.totalCount === 1);
      await plugin.event({ event: { type, properties: { sessionID: "ses_child", requestID: `que_${type}`, answers: [["Yes"]] } } });
      await waitFor(request, (value) => value.totalCount === 0);
    }
    assert.equal(replies.length, 0);
  });
});

test("turn ends become attention or finished items; subagents, placeholders, and interrupts are handled", async () => {
  const sent = [];
  await withPlugin(async ({ request, plugin, messages }) => {
    messages.ses_root = "Two approaches.\n\nShould I use A or B?";
    messages.ses_child = "Subagent report.";
    messages.ses_fresh = "Done. All tests pass.";

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_fresh" } } });
    const snapshot = await waitFor(request, (value) => value.totalCount === 2);
    const byThread = Object.fromEntries(snapshot.threads.map((thread) => [thread.threadId, thread]));
    assert.equal(byThread.ses_child, undefined, "a subagent finishing is not reported");
    assert.equal(byThread.ses_root.items[0].kind, "attention");
    assert.equal(byThread.ses_fresh.items[0].kind, "finished");
    assert.equal(byThread.ses_fresh.sessionTitle, undefined, "placeholder titles fall back to the folder");
    assert.equal(byThread.ses_fresh.title, "OpenCode — other");

    // Replying in OpenCode clears the session's item.
    await plugin["chat.message"]({ sessionID: "ses_root" }, {});
    await waitFor(request, (value) => value.totalCount === 1);

    // Esc: the interrupted turn is neither a question nor a finished report.
    await plugin.event({ event: { type: "session.error", properties: { sessionID: "ses_fresh", error: { name: "MessageAbortedError", data: {} } } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_fresh" } } });
    await waitFor(request, (value) => value.totalCount === 0);

    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_fresh" } } });
    await waitFor(request, (value) => value.totalCount === 1);
    await plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_fresh", info: sessions.fresh } } });
    await waitFor(request, (value) => value.totalCount === 0);
  }, { notify: (notification) => sent.push(notification) });
  assert.deepEqual(sent.slice(0, 2).map((notification) => [notification.title, notification.urgency]), [
    ["OpenCode · Wire up OpenCode", "normal"],
    ["OpenCode · other", "low"],
  ]);
});

test("without the in-process client the plugin only stays out of the way", async () => {
  const plugin = await AgentFoldOpenCode({ client: {} });
  await plugin.event({ event: { type: "permission.asked", properties: { id: "per_x", sessionID: "s" } } });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s" } } });
});

/** A fake of OpenCode's in-process client plus a live bridge the plugin can find. */
async function withPlugin(run, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-opencode-test-"));
  const server = await startBridgeServer({ dataDir, port: 0, ...options });
  const previousDataDir = process.env.AGENT_FOLD_DATA_DIR;
  process.env.AGENT_FOLD_DATA_DIR = dataDir;
  const replies = [];
  const messages = {};
  const http = {
    async get({ url, path }) {
      if (url === "/session/{sessionID}") return { data: Object.values(sessions).find((session) => session.id === path.sessionID) };
      if (url === "/session/{sessionID}/message") {
        const text = messages[path.sessionID];
        return { data: text === undefined ? [] : [{ info: { role: "assistant" }, parts: [{ type: "step-start" }, { type: "text", text }] }] };
      }
      return { data: undefined };
    },
    async post({ url, path, body }) {
      replies.push({ url, path, body });
      return { data: true };
    },
  };
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-agent-fold-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const plugin = await AgentFoldOpenCode({ client: { _client: http } });
    await run({ request, plugin, replies, messages });
  } finally {
    if (previousDataDir === undefined) delete process.env.AGENT_FOLD_DATA_DIR;
    else process.env.AGENT_FOLD_DATA_DIR = previousDataDir;
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
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
