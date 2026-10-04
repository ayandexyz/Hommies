import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";
import { detectReplyRequest, lastAssistantText } from "../dist/stop-detection.js";
import { sessionTitle } from "../dist/transcript.js";

test("closing questions and decision requests are detected", () => {
  assert.equal(
    detectReplyRequest("I found two options.\n\nShould I use the SSE stream or keep polling?"),
    "Should I use the SSE stream or keep polling?",
  );
  assert.equal(
    detectReplyRequest("Tests pass.\n\nWant me to open a PR for this?"),
    "Want me to open a PR for this?",
  );
  assert.ok(detectReplyRequest("Both approaches work. Let me know which approach you prefer."));
  assert.ok(detectReplyRequest("Here is the diff.\n\n**Does this look right?**"));
});

test("finished turns are not flagged", () => {
  assert.equal(detectReplyRequest("Done. All 12 tests pass and the build is green."), null);
  assert.equal(
    detectReplyRequest("Why did it fail? The port was taken.\n\nI fixed it by picking a free port. Tests pass."),
    null,
  );
  assert.equal(detectReplyRequest("Added the check:\n\n```ts\nconst ok = a ?? b ? 1 : 2; // why?\n```"), null);
  assert.equal(detectReplyRequest("   "), null);
});

test("the final assistant text is read from a transcript", () => {
  const transcript = [
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"t1"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Found it."}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Should I fix it?"}]}}',
    '{"type":"system","subtype":"stop_hook_summary"}',
    "",
  ].join("\n");
  assert.equal(lastAssistantText(transcript), "Found it.\nShould I fix it?");
  assert.equal(lastAssistantText('partial json line\n{"type":"user","message":{"content":"x"}}\n'), null);
});

test("session titles prefer /rename over the latest generated title", () => {
  const ai = (title) => JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: "s" });
  assert.equal(sessionTitle([ai("Old"), '{"type":"user"}', ai("Fix bar  widget")].join("\n")), "Fix bar widget");
  assert.equal(
    sessionTitle([ai("Generated"), JSON.stringify({ type: "custom-title", customTitle: "My name" }), ai("Later")].join("\n")),
    "My name",
  );
  assert.equal(sessionTitle('{"type":"assistant","message":{"content":"no title"}}'), null);
});

test("threads expose the session title and project folder", async () => {
  await withServer(async ({ request }) => {
    await request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: "t1", cwd: "/home/me/hommies",
      last_assistant_message: "Ship it?", session_title: "Stop hook detection",
    });
    await request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: "t2", cwd: "/home/me/other", last_assistant_message: "Ship it?",
    });
    const [titled, untitled] = (await pending(request)).threads;
    assert.equal(titled.sessionTitle, "Stop hook detection");
    assert.equal(titled.project, "hommies");
    assert.equal(titled.title, "Claude Code — hommies", "title stays backward compatible");
    assert.equal(untitled.sessionTitle, undefined);
    assert.equal(untitled.project, "other");
  });
});

test("Stop with a question creates a dismissable attention item", async () => {
  await withServer(async ({ request }) => {
    const stop = { hook_event_name: "Stop", session_id: "s1", cwd: "/home/me/proj" };

    const finished = await request("POST", "/v1/providers/claude/stop", { ...stop, last_assistant_message: "All done.\n\nDetails follow." });
    assert.deepEqual(await finished.json(), { ok: true, attention: false });
    const status = await pending(request);
    assert.equal(status.totalCount, 1, "finished turns notify too");
    assert.equal(status.threads[0].items[0].kind, "finished");
    assert.equal(status.threads[0].items[0].summary, "All done.");

    const asked = await request("POST", "/v1/providers/claude/stop", { ...stop, last_assistant_message: "Should I commit?" });
    assert.deepEqual(await asked.json(), { ok: true, attention: true });
    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.threads[0].title, "Claude Code — proj");
    const item = snapshot.threads[0].items[0];
    assert.equal(item.kind, "attention");
    assert.equal(item.summary, "Should I commit?");

    const dismissed = await request("POST", "/v1/respond", { threadId: "s1", requestId: item.id, decision: "cancel" });
    assert.equal(dismissed.status, 200);
    assert.equal((await pending(request)).totalCount, 0);
  });
});

test("attention clears when the user replies, the session ends, or Claude resumes", async () => {
  await withServer(async ({ request }) => {
    const ask = (session) => request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: session, cwd: "/tmp", last_assistant_message: "Which one?",
    });

    await ask("s1");
    await ask("s1");
    assert.equal((await pending(request)).totalCount, 1, "one item per session");

    await request("POST", "/v1/providers/claude/resume", { hook_event_name: "UserPromptSubmit", session_id: "s1" });
    assert.equal((await pending(request)).totalCount, 0);

    await ask("s2");
    await request("POST", "/v1/providers/claude/resume", { hook_event_name: "SessionEnd", session_id: "s2" });
    assert.equal((await pending(request)).totalCount, 0);

    await ask("s3");
    await request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: "s3", cwd: "/tmp", last_assistant_message: "Finished the refactor.",
    });
    const replaced = await pending(request);
    assert.equal(replaced.totalCount, 1, "a later finished turn replaces the question");
    assert.deepEqual(replaced.threads.map((thread) => thread.items.map((item) => item.kind)), [["finished"]]);
  });
});

async function pending(request) {
  return request("GET", "/v1/pending").then((response) => response.json());
}

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-stop-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-hommies-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
