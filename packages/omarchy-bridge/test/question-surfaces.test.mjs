import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";

const questionInput = {
  session_id: "question-surface-test",
  transcript_path: "/tmp/question-surface-test.jsonl",
  cwd: "/tmp",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "tool-question-surface-test",
  tool_input: {
    questions: [
      {
        header: "Framework",
        question: "Which framework?",
        options: [
          { label: "React", description: "Use React" },
          { label: "Vue", description: "Use Vue" },
        ],
        multiSelect: false,
      },
    ],
  },
};

test("CLI mode mirrors structured questions without blocking Claude", async () => {
  await withServer(async ({ request }) => {
    assert.equal((await request("POST", "/v1/preferences", {
      questionAnswerSurface: "cli",
    })).status, 200);

    const hookResponse = await request("POST", "/v1/providers/claude/question", questionInput);
    assert.equal(hookResponse.status, 200);
    assert.deepEqual(await hookResponse.json(), {});

    const snapshot = await request("GET", "/v1/pending").then((response) => response.json());
    const item = snapshot.threads[0]?.items[0];
    assert.equal(item?.kind, "question");
    assert.equal(item?.answerSurface, "cli");
    assert.deepEqual(item?.questions, [
      {
        id: "Which framework?",
        header: "Framework",
        question: "Which framework?",
        options: [
          { label: "React", description: "Use React" },
          { label: "Vue", description: "Use Vue" },
        ],
        multiSelect: false,
      },
    ]);

    const topbarAttempt = await request("POST", "/v1/respond", {
      threadId: questionInput.session_id,
      requestId: item.id,
      answers: { "Which framework?": "React" },
    });
    assert.equal(topbarAttempt.status, 409);

    const resolved = await request("POST", "/v1/providers/claude/question/resolved", {
      ...questionInput,
      hook_event_name: "PostToolUse",
      tool_response: { answers: { "Which framework?": "Vue" } },
    });
    assert.equal(resolved.status, 200);
    const empty = await request("GET", "/v1/pending").then((response) => response.json());
    assert.equal(empty.totalCount, 0);
  });
});

test("top-bar mode blocks until every structured question is answered", async () => {
  await withServer(async ({ request }) => {
    const hookResponsePromise = request("POST", "/v1/providers/claude/question", questionInput);
    const snapshot = await waitForPending(request);
    const item = snapshot.threads[0]?.items[0];
    assert.equal(item?.answerSurface, "topbar");

    const answerResponse = await request("POST", "/v1/respond", {
      threadId: questionInput.session_id,
      requestId: item.id,
      answers: { "Which framework?": "React" },
    });
    assert.equal(answerResponse.status, 200);

    const hookResponse = await hookResponsePromise;
    assert.equal(hookResponse.status, 200);
    assert.deepEqual(await hookResponse.json(), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: {
          ...questionInput.tool_input,
          answers: { "Which framework?": "React" },
        },
      },
    });
  });
});

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-question-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const headers = {
      "content-type": "application/json",
      "x-agent-fold-token": connection.token,
    };
    const request = (method, path, body) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await run({ request });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function waitForPending(request) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const snapshot = await request("GET", "/v1/pending").then((response) => response.json());
    if (snapshot.totalCount > 0) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pending question did not appear");
}
