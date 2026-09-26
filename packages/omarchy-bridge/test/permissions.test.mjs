import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";

const permissionInput = {
  session_id: "permission-test",
  cwd: "/tmp/project",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf build" },
};

const questionInput = {
  session_id: "disconnect-test",
  cwd: "/tmp",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "tool-disconnect-test",
  tool_input: { questions: [{ header: "Pick", question: "Which?", options: [{ label: "A" }], multiSelect: false }] },
};

for (const [decision, expected] of [
  ["accept", { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }],
  ["decline", { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } }],
  ["cancel", {}],
]) {
  test(`permission ${decision} is returned to the hook`, async () => {
    await withServer(async ({ request }) => {
      const hookResponsePromise = request("POST", "/v1/providers/claude/permission", permissionInput);
      const snapshot = await waitForCount(request, 1);
      const thread = snapshot.threads[0];
      const item = thread?.items[0];
      assert.equal(thread?.title, "Claude Code — project");
      assert.equal(item?.kind, "permission");
      assert.equal(item?.summary, "Bash: rm -rf build");

      const answer = await request("POST", "/v1/respond", { threadId: permissionInput.session_id, requestId: item.id, decision });
      assert.equal(answer.status, 200);

      const hookResponse = await hookResponsePromise;
      assert.deepEqual(await hookResponse.json(), expected);
      assert.equal((await waitForCount(request, 0)).totalCount, 0);
    });
  });
}

test("permission with an unknown decision is rejected and stays pending", async () => {
  await withServer(async ({ request }) => {
    const controller = new AbortController();
    request("POST", "/v1/providers/claude/permission", permissionInput, controller.signal).catch(() => {});
    const item = (await waitForCount(request, 1)).threads[0].items[0];
    const answer = await request("POST", "/v1/respond", { threadId: permissionInput.session_id, requestId: item.id, decision: "maybe" });
    assert.equal(answer.status, 400);
    assert.equal((await request("GET", "/v1/pending").then((r) => r.json())).totalCount, 1);
    controller.abort();
  });
});

test("permission disappears when the hook disconnects", async () => {
  await withServer(async ({ request }) => {
    const controller = new AbortController();
    request("POST", "/v1/providers/claude/permission", permissionInput, controller.signal).catch(() => {});
    await waitForCount(request, 1);
    controller.abort();
    assert.equal((await waitForCount(request, 0)).totalCount, 0);
  });
});

test("top-bar question disappears when the hook disconnects", async () => {
  await withServer(async ({ request }) => {
    const controller = new AbortController();
    request("POST", "/v1/providers/claude/question", questionInput, controller.signal).catch(() => {});
    const item = (await waitForCount(request, 1)).threads[0].items[0];
    controller.abort();
    assert.equal((await waitForCount(request, 0)).totalCount, 0);

    const late = await request("POST", "/v1/respond", { threadId: questionInput.session_id, requestId: item.id, answers: { "Which?": "A" } });
    assert.equal(late.status, 404);
  });
});

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-permission-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-agent-fold-token": connection.token };
    const request = (method, path, body, signal) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForCount(request, count) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await request("GET", "/v1/pending").then((response) => response.json());
    if (snapshot.totalCount === count) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pending count did not reach ${count}`);
}
