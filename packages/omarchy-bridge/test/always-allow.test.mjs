import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";

const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "pnpm test:*" }], behavior: "allow", destination: "localSettings" };
const permission = (extra) => ({
  session_id: "s1", cwd: "/w/app", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "pnpm test" }, ...extra,
});

test("Always allow returns Claude's own permission suggestions", async () => {
  await withServer(async ({ request }) => {
    const hook = request("POST", "/v1/providers/claude/permission", permission({ permission_suggestions: [suggestion] }));
    const item = await firstItem(request);
    assert.equal(item.canAcceptAlways, true);
    await request("POST", "/v1/respond", { threadId: "s1", requestId: item.id, decision: "acceptAlways" });
    assert.deepEqual((await (await hook).json()).hookSpecificOutput.decision, { behavior: "allow", updatedPermissions: [suggestion] });
  });
});

test("without suggestions, and for Codex, Always allow is a plain allow", async () => {
  await withServer(async ({ request }) => {
    const hook = request("POST", "/v1/providers/claude/permission", permission({}));
    const item = await firstItem(request);
    assert.equal(item.canAcceptAlways, undefined);
    await request("POST", "/v1/respond", { threadId: "s1", requestId: item.id, decision: "acceptAlways" });
    assert.deepEqual((await (await hook).json()).hookSpecificOutput.decision, { behavior: "allow" });

    const codex = request("POST", "/v1/providers/codex/permission", permission({ session_id: "c1", permission_suggestions: [suggestion] }));
    const codexItem = await firstItem(request);
    assert.equal(codexItem.canAcceptAlways, undefined, "Codex rejects updatedPermissions");
    await request("POST", "/v1/respond", { threadId: "c1", requestId: codexItem.id, decision: "acceptAlways" });
    assert.deepEqual((await (await codex).json()).hookSpecificOutput.decision, { behavior: "allow" });
  });
});

test("OpenCode's Always allow asks the plugin to remember it", async () => {
  await withServer(async ({ request }) => {
    const hook = request("POST", "/v1/providers/opencode/permission", permission({ session_id: "o1", request_id: "per_1" }));
    const item = await firstItem(request);
    assert.equal(item.canAcceptAlways, true);
    await request("POST", "/v1/respond", { threadId: "o1", requestId: "per_1", decision: "acceptAlways" });
    assert.deepEqual((await (await hook).json()).hookSpecificOutput.decision, { behavior: "allow", remember: true });
  });
});

test("a plain accept never saves rules, and unknown decisions are rejected", async () => {
  await withServer(async ({ request }) => {
    const hook = request("POST", "/v1/providers/claude/permission", permission({ permission_suggestions: [suggestion] }));
    const item = await firstItem(request);
    assert.equal((await request("POST", "/v1/respond", { threadId: "s1", requestId: item.id, decision: "forever" })).status, 400);
    await request("POST", "/v1/respond", { threadId: "s1", requestId: item.id, decision: "accept" });
    assert.deepEqual((await (await hook).json()).hookSpecificOutput.decision, { behavior: "allow" });
  });
});

async function firstItem(request) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await (await request("GET", "/v1/pending")).json();
    const item = snapshot.threads.flatMap((thread) => thread.items).find((entry) => entry.kind === "permission");
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no permission item appeared");
}

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-always-test-"));
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
