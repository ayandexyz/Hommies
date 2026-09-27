import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";

// Omacode's built-in integration speaks the OpenCode request-id protocol under
// its own provider path; these tests pin that HTTP contract.

test("an Omacode permission is listed under Omacode and answered from the bar", async () => {
  await withBridge(async ({ request }) => {
    const hook = request("POST", "/v1/providers/omacode/permission", {
      session_id: "ses_1", cwd: "/home/me/proj", session_title: "Fix the parser",
      hook_event_name: "PermissionRequest", request_id: "req_1", tool_name: "bash", tool_input: { command: "rm -rf build" },
    });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    const thread = snapshot.threads[0];
    assert.equal(thread.title, "Omacode — proj");
    assert.equal(thread.sessionTitle, "Fix the parser");
    assert.deepEqual(
      [thread.items[0].id, thread.items[0].provider, thread.items[0].kind, thread.items[0].summary],
      ["req_1", "omacode", "permission", "bash: rm -rf build"],
    );
    await request("POST", "/v1/respond", { threadId: "ses_1", requestId: "req_1", decision: "accept" });
    assert.deepEqual(await (await hook).json(), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  });
});

test("an Omacode permission answered in its TUI is cleared from the bar", async () => {
  await withBridge(async ({ request }) => {
    const hook = request("POST", "/v1/providers/omacode/permission", {
      session_id: "ses_1", cwd: "/home/me/proj", hook_event_name: "PermissionRequest",
      request_id: "req_tui", tool_name: "edit", tool_input: { file_path: "/home/me/proj/a.ts" },
    });
    await waitFor(request, (value) => value.totalCount === 1);
    await request("POST", "/v1/providers/omacode/permission/resolved", { session_id: "ses_1", request_id: "req_tui" });
    await waitFor(request, (value) => value.totalCount === 0);
    assert.deepEqual(await (await hook).json(), {});
  });
});

test("Omacode questions are answered with one label array per question", async () => {
  await withBridge(async ({ request }) => {
    const hook = request("POST", "/v1/providers/omacode/question", {
      session_id: "ses_1", cwd: "/home/me/proj", request_id: "q_1",
      questions: [
        { question: "Which colors?", header: "Colors", multiple: true, options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }] },
        { question: "Name?", header: "Name", options: [{ label: "Ada", description: "" }] },
      ],
    });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    const item = snapshot.threads[0].items[0];
    assert.equal(item.provider, "omacode");
    assert.equal(item.questions.length, 2);
    assert.equal(item.questions[0].multiSelect, true);
    await request("POST", "/v1/respond", {
      threadId: "ses_1", requestId: item.id, answers: { "Which colors?": "Red, Blue", "Name?": "Grace" },
    });
    assert.deepEqual(await (await hook).json(), { answers: [["Red", "Blue"], ["Grace"]] });
  });
});

test("an Omacode question answered in its TUI is cleared from the bar", async () => {
  await withBridge(async ({ request }) => {
    const hook = request("POST", "/v1/providers/omacode/question", {
      session_id: "ses_1", request_id: "q_tui", questions: [{ question: "Go?", options: [{ label: "Yes" }] }],
    });
    await waitFor(request, (value) => value.totalCount === 1);
    await request("POST", "/v1/providers/omacode/question/resolved", { session_id: "ses_1", request_id: "q_tui" });
    await waitFor(request, (value) => value.totalCount === 0);
    assert.deepEqual(await (await hook).json(), {});
  });
});

test("Omacode turn ends are reported and cleared by the next prompt", async () => {
  await withBridge(async ({ request }) => {
    await request("POST", "/v1/providers/omacode/stop", {
      session_id: "ses_1", cwd: "/home/me/proj", hook_event_name: "Stop", last_assistant_message: "Refactor done. All tests pass.",
    });
    const snapshot = await waitFor(request, (value) => value.totalCount === 1);
    assert.deepEqual([snapshot.threads[0].items[0].provider, snapshot.threads[0].items[0].kind], ["omacode", "finished"]);
    await request("POST", "/v1/providers/omacode/resume", { session_id: "ses_1", hook_event_name: "UserPromptSubmit" });
    await waitFor(request, (value) => value.totalCount === 0);
  });
});

async function withBridge(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-omacode-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-agent-fold-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request });
  } finally {
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
