import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDesktopNotifier, escapeMarkup } from "../dist/notifier.js";
import { startBridgeServer } from "../dist/server.js";

test("every new item sends one notification named after its session", async () => {
  const sent = [];
  await withServer({ notify: (notification) => sent.push(notification) }, async ({ request }) => {
    await request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: "s1", cwd: "/home/me/hommies",
      session_title: "Stop hook detection", last_assistant_message: "Should I commit?",
    });
    await request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: "s2", cwd: "/home/me/other", last_assistant_message: "All tests pass.",
    });
    await request("POST", "/v1/preferences", { questionAnswerSurface: "cli" });
    await request("POST", "/v1/providers/claude/question", {
      session_id: "s3", cwd: "/home/me/q", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion",
      tool_use_id: "t1", tool_input: { questions: [{ header: "H", question: "Which one?", options: [] }] },
    });
  });
  assert.deepEqual(sent, [
    { key: "s1", title: "Claude · Stop hook detection", body: "Waiting for your reply: Should I commit?", urgency: "normal" },
    { key: "s2", title: "Claude · other", body: "Finished: All tests pass.", urgency: "low" },
    { key: "s3", title: "Claude · q", body: "Question: Which one?", urgency: "normal" },
  ]);
});

test("notifications can be turned off through preferences", async () => {
  const sent = [];
  await withServer({ notify: (notification) => sent.push(notification) }, async ({ request }) => {
    const off = await request("POST", "/v1/preferences", { desktopNotifications: false });
    assert.equal((await off.json()).desktopNotifications, false);
    await request("POST", "/v1/providers/claude/stop", {
      hook_event_name: "Stop", session_id: "s1", cwd: "/tmp", last_assistant_message: "Done.",
    });
    assert.equal((await request("POST", "/v1/preferences", { desktopNotifications: "yes" })).status, 400);
    assert.equal((await request("POST", "/v1/preferences", {})).status, 400);
  });
  assert.deepEqual(sent, []);
});

test("notify-send is called without a shell and replaces per session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hommies-notify-test-"));
  try {
    const log = join(dir, "calls.jsonl");
    const stub = join(dir, "notify-send");
    await writeFile(stub, `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("42\\n");
`);
    await chmod(stub, 0o755);
    const notify = createDesktopNotifier(stub);
    // Back to back: the second call must still wait for the first id.
    notify({ key: "s1", title: "Claude · a", body: "Finished: <b>x</b> & y", urgency: "low" });
    notify({ key: "s1", title: "Claude · a", body: "Question: $(rm -rf ~)", urgency: "normal" });
    const calls = await waitForLines(log, 2);
    assert.deepEqual(calls[0], [
      "--app-name=Hommies", "--urgency=low", "--print-id", "--", "Claude · a", "Finished: &lt;b&gt;x&lt;/b&gt; &amp; y",
    ]);
    assert.deepEqual(calls[1], [
      "--app-name=Hommies", "--urgency=normal", "--print-id", "--replace-id=42", "--", "Claude · a", "Question: $(rm -rf ~)",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markup characters are escaped", () => {
  assert.equal(escapeMarkup("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
});

async function waitForLines(path, count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const lines = await readFile(path, "utf8").then((text) => text.trim().split("\n").filter(Boolean), () => []);
    if (lines.length >= count) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} notify-send calls`);
}

async function withServer(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-notify-server-"));
  const server = await startBridgeServer({ dataDir, port: 0, ...options });
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
