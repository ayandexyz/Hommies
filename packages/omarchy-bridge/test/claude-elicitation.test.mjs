import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  claudeElicitationQuestion, claudeElicitationReply, claudeElicitationResolved,
} from "../dist/claude-elicitation.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const elicitation = {
  session_id: "claude-elicit-1",
  transcript_path: "/tmp/claude-elicit-1.jsonl",
  cwd: "/w/app",
  hook_event_name: "Elicitation",
  mcp_server_name: "deploy",
  elicitation_id: "form-1",
  message: "Choose a deployment target",
  mode: "form",
  requested_schema: {
    type: "object",
    required: ["environment", "replicas", "confirm"],
    properties: {
      environment: { type: "string", title: "Environment", enum: ["staging", "production"] },
      replicas: { type: "integer", description: "Replica count" },
      confirm: { type: "boolean", title: "Confirm" },
      note: { type: "string", title: "Optional note" },
    },
  },
};

test("Claude MCP form elicitations map to typed Hommies questions", () => {
  const question = claudeElicitationQuestion(elicitation);
  assert.equal(question.tool_use_id, "elicitation:form-1");
  assert.deepEqual(question.tool_input.questions, [
    {
      id: "environment", header: "environment", question: "Choose a deployment target\nEnvironment",
      options: [{ label: "staging" }, { label: "production" }], multiSelect: false,
    },
    {
      id: "replicas", header: "replicas", question: "Choose a deployment target\nReplica count",
      options: [], multiSelect: false,
    },
    {
      id: "confirm", header: "confirm", question: "Choose a deployment target\nConfirm",
      options: [{ label: "Yes" }, { label: "No" }], multiSelect: false,
    },
  ], "optional fields stay optional");
  assert.deepEqual(claudeElicitationReply(elicitation, { hookSpecificOutput: { updatedInput: { answers: {
    environment: "production",
    replicas: "3",
    confirm: "Yes",
  } } } }), {
    hookSpecificOutput: {
      hookEventName: "Elicitation", action: "accept",
      content: { environment: "production", replicas: 3, confirm: true },
    },
  });
  assert.equal(claudeElicitationQuestion({ ...elicitation, mode: "url", requested_schema: undefined }), null,
    "URL-mode authentication stays in Claude's native dialog");
  assert.equal(claudeElicitationQuestion({
    ...elicitation,
    requested_schema: {
      type: "object", required: ["environment", "tags"],
      properties: { environment: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
    },
  }), null, "one unsupported required field keeps the whole form in Claude's native dialog");
  assert.deepEqual(claudeElicitationResolved({
    session_id: elicitation.session_id, cwd: elicitation.cwd, hook_event_name: "ElicitationResult",
    mcp_server_name: "deploy", elicitation_id: "form-1", action: "decline",
  }), {
    session_id: elicitation.session_id, cwd: elicitation.cwd, hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion", tool_use_id: "elicitation:form-1", tool_input: {},
  });
});

test("the compiled Claude hook answers MCP elicitations and clears native replies", async () => {
  await withServer(async ({ dataDir, request }) => {
    const hook = runHook(elicitation, { HOMMIES_DATA_DIR: dataDir });
    const snapshot = await waitForPending(request);
    const item = snapshot.threads[0]?.items[0];
    assert.equal(item.provider, "claude");
    assert.equal(item.kind, "question");
    assert.equal(item.answerSurface, "topbar");

    await request("POST", "/v1/respond", {
      threadId: elicitation.session_id,
      requestId: item.id,
      answers: {
        environment: "staging",
        replicas: "2",
        confirm: "No",
      },
    });
    assert.deepEqual(JSON.parse(await hook), {
      hookSpecificOutput: {
        hookEventName: "Elicitation", action: "accept",
        content: { environment: "staging", replicas: 2, confirm: false },
      },
    });

    await request("POST", "/v1/preferences", { questionAnswerSurface: "cli" });
    const native = { ...elicitation, elicitation_id: "form-native" };
    assert.equal(await runHook(native, { HOMMIES_DATA_DIR: dataDir }), "");
    assert.equal((await waitForPending(request)).totalCount, 1);
    assert.equal(await runHook({
      session_id: native.session_id, cwd: native.cwd, hook_event_name: "ElicitationResult",
      mcp_server_name: native.mcp_server_name, elicitation_id: native.elicitation_id, action: "decline",
    }, { HOMMIES_DATA_DIR: dataDir }), "");
    assert.equal((await pending(request)).totalCount, 0);
  });
});

function runHook(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, "claude-hook.js")], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-elicitation-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-hommies-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ dataDir, request });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const pending = (request) => request("GET", "/v1/pending").then((response) => response.json());

async function waitForPending(request) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await pending(request);
    if (snapshot.totalCount > 0) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pending elicitation did not appear");
}
