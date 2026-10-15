import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatSessionDirName, lastFreecodeAssistantText, readFreecodeSessionTitle } from "../dist/freecode-transcript.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("formatSessionDirName matches freecode's own path formatter", () => {
  assert.equal(formatSessionDirName("/home/ayande/Project/opencode"), "home__ayande__Project__opencode");
  assert.equal(formatSessionDirName("/home/ayande/Project/my-project"), "home__ayande__Project__my_h_project");
});

async function writeFreecodeSession(freecodeHome, cwd, sessionId, { title, messages }) {
  const dir = join(freecodeHome, "sessions", formatSessionDirName(cwd), sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ title }));
  await writeFile(join(dir, "messages.jsonl"), messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
}

test("session title and last assistant text come from freecode's own session store", async () => {
  const home = await mkdtemp(join(tmpdir(), "freecode-home-"));
  try {
    await writeFreecodeSession(join(home, ".freecode"), "/work/app", "s1", {
      title: "Add Freecode parity",
      messages: [
        { role: "user", parts: [{ type: "text", content: "fix it" }] },
        { role: "assistant", parts: [{ type: "tool", tool: { name: "bash", args: {} } }] },
        { role: "assistant", parts: [{ type: "text", content: "Should I merge?" }] },
      ],
    });
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.equal(await readFreecodeSessionTitle("/work/app", "s1"), "Add Freecode parity");
      assert.equal(await lastFreecodeAssistantText("/work/app", "s1"), "Should I merge?");
      assert.equal(await readFreecodeSessionTitle("/work/app", "missing"), null);
      assert.equal(await lastFreecodeAssistantText(undefined, undefined), null);
    } finally {
      process.env.HOME = originalHome;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Freecode turn ends create items, and clear on reply", async () => {
  await withServer({}, async ({ request }) => {
    await request("POST", "/v1/providers/freecode/stop", {
      hook_event_name: "Stop", session_id: "f1", cwd: "/home/me/proj",
      session_title: "freecode parity", last_assistant_message: "Want me to run the tests?",
    });
    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 1);
    assert.equal(snapshot.threads[0].sessionTitle, "freecode parity");
    assert.equal(snapshot.threads[0].items[0].provider, "freecode");
    assert.equal(snapshot.threads[0].items[0].kind, "attention");

    await request("POST", "/v1/providers/freecode/resume", { hook_event_name: "UserPromptSubmit", session_id: "f1" });
    assert.equal((await pending(request)).totalCount, 0);
  });
});

test("Freecode permission requests answer allow/deny through the bar", async () => {
  const permissionInput = {
    session_id: "freecode-permission", cwd: "/tmp/project", hook_event_name: "PermissionRequest",
    tool_name: "bash", tool_input: { command: "rm -rf build" },
  };
  await withServer({}, async ({ request }) => {
    const hookResponsePromise = request("POST", "/v1/providers/freecode/permission", permissionInput);
    const snapshot = await waitForCount(request, 1);
    const item = snapshot.threads[0]?.items[0];
    assert.equal(item?.kind, "permission");
    assert.equal(item?.canAcceptAlways, undefined, "freecode has no remembered-rule mechanism");

    await request("POST", "/v1/respond", { threadId: permissionInput.session_id, requestId: item.id, decision: "decline" });
    const hookResponse = await hookResponsePromise;
    assert.deepEqual(await hookResponse.json(), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } });
  });
});

test("Freecode mirrors the question tool and injects answers back", async () => {
  const questionInput = {
    session_id: "freecode-question", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion",
    tool_use_id: "call_1", tool_input: { questions: [{ header: "Pick", question: "Which?", options: [{ label: "A" }], multiSelect: false }] },
  };
  await withServer({}, async ({ request }) => {
    const hookResponsePromise = request("POST", "/v1/providers/freecode/question", questionInput);
    const item = (await waitForCount(request, 1)).threads[0]?.items[0];
    assert.equal(item?.provider, "freecode");
    assert.equal(item?.kind, "question");

    await request("POST", "/v1/respond", { threadId: questionInput.session_id, requestId: item.id, answers: { "Which?": "A" } });
    const hookResponse = await hookResponsePromise;
    assert.deepEqual(await hookResponse.json(), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...questionInput.tool_input, answers: { "Which?": "A" } } },
    });

    await request("POST", "/v1/providers/freecode/question/resolved", { session_id: "freecode-question", tool_use_id: "call_1" });
    assert.equal((await pending(request)).totalCount, 0);
  });
});

test("the compiled freecode hook reports a Stop from env vars and argv, never reading stdin", async () => {
  await withServer({}, async ({ request, dataDir }) => {
    const freecodeHome = join(dataDir, "freecode-home");
    await writeFreecodeSession(join(freecodeHome, ".freecode"), "/w/app", "s9", {
      title: "Rollout test", messages: [{ role: "assistant", parts: [{ type: "text", content: "All tests pass." }] }],
    });
    const stdout = await runHook("Stop", {
      HOMMIES_DATA_DIR: dataDir, HOME: freecodeHome,
      CLAUDE_SESSION_ID: "s9", CLAUDE_CWD: "/w/app",
    });
    assert.equal(stdout, "", "turn hooks never write to stdout");
    const thread = (await pending(request)).threads[0];
    assert.equal(thread.sessionTitle, "Rollout test");
    assert.deepEqual(thread.items.map((item) => [item.provider, item.kind, item.summary]), [["freecode", "finished", "All tests pass."]]);
  });
});

test("the compiled freecode hook reports PreToolUse activity for an ordinary tool", async () => {
  await withServer({}, async ({ request, dataDir }) => {
    const stdout = await runHook("PreToolUse", {
      HOMMIES_DATA_DIR: dataDir,
      CLAUDE_SESSION_ID: "a1", CLAUDE_CWD: "/w/app", CLAUDE_TOOL_NAME: "bash", CLAUDE_TOOL_INPUT: JSON.stringify({ command: "ls" }),
    });
    assert.equal(stdout, "");
    const session = (await pending(request)).sessions?.find((s) => s.threadId === "a1");
    assert.deepEqual(session?.steps, ["bash ls"]);
  });
});

test("the compiled freecode hook stays silent on PermissionRequest when the bridge is unreachable", async () => {
  const stdout = await runHook("PermissionRequest", {
    HOMMIES_DATA_DIR: join(await mkdtemp(join(tmpdir(), "freecode-no-bridge-")), "nope"),
    CLAUDE_SESSION_ID: "p1", CLAUDE_CWD: "/w/app", CLAUDE_TOOL_NAME: "bash", CLAUDE_TOOL_INPUT: JSON.stringify({ command: "rm -rf /" }),
  });
  assert.equal(stdout, "", "no connection means passthrough, never an implicit allow");
});

function runHook(event, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, "freecode-hook.js"), event], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end();
  });
}

async function pending(request) {
  return request("GET", "/v1/pending").then((response) => response.json());
}

async function waitForCount(request, count) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await pending(request);
    if (snapshot.totalCount === count) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pending count did not reach ${count}`);
}

async function withServer(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-freecode-test-"));
  const server = await startBridgeServer({ dataDir, port: 0, ...options });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = { "content-type": "application/json", "x-hommies-token": connection.token };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request, dataDir });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
