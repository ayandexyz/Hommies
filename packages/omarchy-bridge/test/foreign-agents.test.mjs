import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  antigravityAnswerReply, antigravityQuestion, grokAnswerReply, grokQuestion, lastAntigravityText, normalizeToolInput, translateAntigravity, translateGemini, translateGrok,
} from "../dist/foreign-hook.js";
import { checkHooks, runSetup } from "../dist/setup.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("tool arguments are renamed to the fields steps are labelled with", () => {
  assert.deepEqual(normalizeToolInput({ CommandLine: "ls", Cwd: "/w" }), { command: "ls" });
  assert.deepEqual(normalizeToolInput({ TargetFile: "/w/a.ts", CodeContent: "x" }), { file_path: "/w/a.ts", content: "x" });
  assert.deepEqual(normalizeToolInput({ absolute_path: "/w/b.ts" }), { file_path: "/w/b.ts" });
  assert.deepEqual(normalizeToolInput({ filePath: "/w/c.ts", oldString: "a", newString: "b" }), { file_path: "/w/c.ts", old_string: "a", new_string: "b" });
  assert.deepEqual(normalizeToolInput(null), {});
});

test("Gemini CLI events map onto Claude's", () => {
  const base = { session_id: "g1", cwd: "/w/app", transcript_path: "/t", timestamp: "2026-10-05T00:00:00Z" };
  assert.deepEqual(translateGemini({ ...base, hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "pytest" } }),
    { session_id: "g1", cwd: "/w/app", hook_event_name: "PreToolUse", tool_name: "run_shell_command", tool_input: { command: "pytest" } });
  assert.deepEqual(translateGemini({ ...base, hook_event_name: "BeforeAgent", prompt: "fix it" }),
    { session_id: "g1", cwd: "/w/app", hook_event_name: "UserPromptSubmit", prompt: "fix it" });
  assert.deepEqual(translateGemini({ ...base, hook_event_name: "AfterAgent", prompt: "fix it", prompt_response: "Fixed.", stop_hook_active: false }),
    { session_id: "g1", cwd: "/w/app", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Fixed." });
  assert.equal(translateGemini({ ...base, hook_event_name: "SessionEnd", reason: "exit" }).hook_event_name, "SessionEnd");
  for (const ignored of ["AfterTool", "AfterModel", "BeforeModel", "PreCompress", "Notification"]) {
    assert.equal(translateGemini({ ...base, hook_event_name: ignored }), null, ignored);
  }
});

test("Grok Build camelCase payloads and environment map onto Claude's", () => {
  assert.deepEqual(translateGrok({ hookEventName: "PreToolUse", sessionId: "x1", cwd: "/w", toolName: "Bash", toolInput: { command: "ls" } }, {}),
    { session_id: "x1", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  // Event and session from the environment, folder from workspaceRoot.
  assert.deepEqual(translateGrok({ workspaceRoot: "/w/app", prompt: "hi" }, { GROK_HOOK_EVENT: "UserPromptSubmit", GROK_SESSION_ID: "x2" }),
    { session_id: "x2", cwd: "/w/app", hook_event_name: "UserPromptSubmit", prompt: "hi" });
  assert.deepEqual(translateGrok({ hookEventName: "Stop", sessionId: "x3", lastAssistantMessage: "Done." }, {}),
    { session_id: "x3", cwd: undefined, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." });
  assert.deepEqual(translateGrok({ hookEventName: "StopFailure", sessionId: "x4", error: "rate_limit" }, {}),
    { session_id: "x4", cwd: undefined, hook_event_name: "StopFailure", error: "rate_limit" });
  assert.equal(translateGrok({ hookEventName: "PreCompact", sessionId: "x5" }, {}), null);
});

// Shapes captured from Grok Build 1.0.46: every field twice, and two event names.
const grokPayload = (claudeName, grokName, extra) => ({
  hook_event_name: claudeName, hookEventName: grokName, session_id: "g-1", sessionId: "g-1",
  cwd: "/w/app", workspaceRoot: "/w/app", permissionMode: "default", ...extra,
});

test("real Grok Build payloads: Claude's event name wins over Grok's snake_case one", () => {
  const env = { GROK_HOOK_EVENT: "pre_tool_use", GROK_SESSION_ID: "g-1" };
  assert.deepEqual(translateGrok(grokPayload("PreToolUse", "pre_tool_use", {
    tool_name: "run_terminal_command", toolName: "run_terminal_command",
    tool_input: { command: "ls -la", description: "List files" }, toolInput: { command: "ls -la", description: "List files" },
  }), env), { session_id: "g-1", cwd: "/w/app", hook_event_name: "PreToolUse", tool_name: "run_terminal_command", tool_input: { command: "ls -la", description: "List files" } });
  // Only Grok's snake_case name: converted.
  assert.equal(translateGrok({ hookEventName: "user_prompt_submit", sessionId: "g-1", prompt: "hi" }, {}).hook_event_name, "UserPromptSubmit");
  assert.equal(translateGrok({ sessionId: "g-1" }, { GROK_HOOK_EVENT: "session_start" }).hook_event_name, "SessionStart");

  const stop = translateGrok(grokPayload("Stop", "stop", { reason: "end_turn", lastAssistantMessage: "done", stopHookActive: false }), {});
  assert.equal(stop.hook_event_name, "Stop");
  assert.equal(stop.last_assistant_message, "done");
  assert.equal(translateGrok(grokPayload("Stop", "stop", { reason: "shutdown" }), {}), null, "the session-end Stop is not a turn end");
  assert.deepEqual(translateGrok(grokPayload("StopCancelled", "stop_cancelled", { reason: "user_interrupt" }), {}),
    { session_id: "g-1", cwd: "/w/app", hook_event_name: "StopCancelled" });
  assert.equal(translateGrok(grokPayload("Stop", "stop", { reason: "end_turn", subagentType: "explore" }), {}), null, "a subagent's stop is not the session's");
});

test("Antigravity ask_question becomes a mirrored AskUserQuestion, and its reply comes from the transcript", () => {
  const payload = {
    conversationId: "a-7", stepIdx: 2, workspacePaths: [], error: "", modelName: "m",
    toolCall: { name: "ask_question", args: { questions: [{ is_multi_select: false, options: ["Red", "Blue"], question: "Which color do you prefer?" }], toolAction: "Asking" } },
  };
  assert.deepEqual(antigravityQuestion(payload), {
    hook_event_name: "PreToolUse", session_id: "a-7", tool_name: "AskUserQuestion", tool_use_id: "a-7:2",
    tool_input: { questions: [{ question: "Which color do you prefer?", header: "Question", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] },
  });
  assert.equal(antigravityQuestion({ ...payload, toolCall: { name: "run_command", args: {} } }), null);

  const transcript = [
    { step_index: "0", source: "USER_EXPLICIT", type: "USER_INPUT", content: "old prompt" },
    { step_index: "1", source: "MODEL", type: "PLANNER_RESPONSE", content: "old answer" },
    { step_index: "2", source: "USER_EXPLICIT", type: "USER_INPUT", content: "run it" },
    { step_index: "3", source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: {} }] },
    { step_index: "4", source: "MODEL", type: "GENERIC", content: "exit 0" },
    { step_index: "5", source: "MODEL", type: "PLANNER_RESPONSE", content: "All done. Should I commit?" },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  assert.equal(lastAntigravityText(transcript), "All done. Should I commit?");
  assert.equal(lastAntigravityText(transcript.split("\n").slice(0, 4).join("\n")), null, "no reply after the latest prompt yet");
});

test("Grok's ask_user_question becomes an AskUserQuestion, and answers use Grok's own wording", () => {
  const payload = grokPayload("PreToolUse", "pre_tool_use", {
    tool_name: "ask_user_question", toolName: "ask_user_question", tool_use_id: "call-1",
    tool_input: { questions: [
      { question: "Which color?", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }] },
      { question: "Which sizes?", options: [{ label: "S", description: "" }, { label: "M", description: "" }], multi_select: true },
    ] },
  });
  assert.deepEqual(grokQuestion(payload, {}), {
    hook_event_name: "PreToolUse", session_id: "g-1", cwd: "/w/app", tool_name: "AskUserQuestion", tool_use_id: "call-1",
    tool_input: { questions: [
      { question: "Which color?", header: "Question 1", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false },
      { question: "Which sizes?", header: "Question 2", options: [{ label: "S" }, { label: "M" }], multiSelect: true },
    ] },
  });
  assert.equal(translateGrok(payload, {}), null, "the generic hook leaves the question to the question entry");
  assert.equal(grokQuestion({ ...payload, tool_name: "run_terminal_command", toolName: "run_terminal_command" }, {}), null);

  const reply = grokAnswerReply({ answers: [{ question: "Which color?", answer: "Blue" }, { question: "Which sizes?", answer: "S, M" }] });
  assert.equal(reply.decision, "deny");
  assert.match(reply.reason, /^User has answered your questions: "Which color\?"="Blue", "Which sizes\?"="S, M"\. You can now continue/);
  assert.equal(grokAnswerReply({}), null);
});

test("Antigravity events come from the hook argument", () => {
  const base = { conversationId: "a1", workspacePaths: ["/w/app", "/w/lib"], transcriptPath: "/t", modelName: "m" };
  assert.deepEqual(translateAntigravity({ ...base, toolCall: { name: "run_command", args: { CommandLine: "make" } }, stepIdx: 3, error: "" }, "PostToolUse"),
    { session_id: "a1", cwd: "/w/app", hook_event_name: "PreToolUse", tool_already_ran: true, tool_name: "run_command", tool_input: { command: "make" } });
  assert.equal(translateAntigravity({ ...base, toolCall: { name: "run_command", args: {} }, error: "exit 2" }, "PostToolUse").hook_event_name, "PostToolUseFailure");
  assert.deepEqual(translateAntigravity({ ...base, executionNum: 1, terminationReason: "done", error: "", fullyIdle: true }, "Stop"),
    { session_id: "a1", cwd: "/w/app", hook_event_name: "Stop" });
  assert.equal(translateAntigravity({ ...base, fullyIdle: false, error: "" }, "Stop"), null, "a non-idle stop is not a turn end");
  assert.deepEqual(translateAntigravity({ ...base, error: "quota exceeded" }, "Stop"),
    { session_id: "a1", cwd: "/w/app", hook_event_name: "StopFailure", error: "agent_error", error_details: "quota exceeded" });
  assert.equal(translateAntigravity(base, "PreInvocation"), null);
  assert.equal(translateAntigravity(base, undefined), null);
});

test("setup registers Gemini CLI, Antigravity, and Grok Build hooks and removes only ours", async () => {
  await withHome(async ({ home, environment }) => {
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await mkdir(join(home, ".grok"));
    const gemini = join(home, ".gemini", "settings.json");
    const antigravity = join(home, ".gemini", "config", "hooks.json");
    const grok = join(home, ".grok", "hooks", "hommies.json");
    await writeFile(gemini, JSON.stringify({ theme: "dark", hooks: { BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "lint.sh" }] }] } }));
    await writeFile(antigravity, JSON.stringify({ "their-hook": { enabled: true, Stop: [{ type: "command", command: "say done" }] } }));

    const providers = ["gemini", "antigravity", "grok"];
    const results = await runSetup({ uninstall: false, dryRun: false, providers }, environment);
    assert.deepEqual(results.map((result) => [result.provider, result.status]), [["gemini", "updated"], ["antigravity", "updated"], ["grok", "updated"]]);

    const geminiConfig = JSON.parse(await readFile(gemini, "utf8"));
    assert.equal(geminiConfig.theme, "dark");
    assert.deepEqual(Object.keys(geminiConfig.hooks).sort(), ["AfterAgent", "BeforeAgent", "BeforeTool", "SessionEnd", "SessionStart"]);
    assert.equal(geminiConfig.hooks.BeforeTool.length, 2, "the user's own hook stays");
    assert.deepEqual(geminiConfig.hooks.BeforeTool[1], { matcher: "*", hooks: [{
      type: "command", command: "test -f /opt/hommies/dist/gemini-hook.js && node /opt/hommies/dist/gemini-hook.js || echo '{}'", timeout: 5000,
    }] });

    const antigravityConfig = JSON.parse(await readFile(antigravity, "utf8"));
    assert.ok(antigravityConfig["their-hook"], "other hook entries stay");
    assert.deepEqual(antigravityConfig.hommies, {
      enabled: true,
      PreToolUse: [{ matcher: "^ask_question$", hooks: [{
        type: "command", command: "test -f /opt/hommies/dist/antigravity-hook.js && node /opt/hommies/dist/antigravity-hook.js PreToolUse || echo '{}'", timeout: 305,
      }] }],
      PostToolUse: [{ matcher: "*", hooks: [{
        type: "command", command: "test -f /opt/hommies/dist/antigravity-hook.js && node /opt/hommies/dist/antigravity-hook.js PostToolUse || echo '{}'", timeout: 5,
      }] }],
      Stop: [{ type: "command", command: "test -f /opt/hommies/dist/antigravity-hook.js && node /opt/hommies/dist/antigravity-hook.js Stop || echo '{}'", timeout: 5 }],
    });

    const grokConfig = JSON.parse(await readFile(grok, "utf8"));
    assert.deepEqual(grokConfig.hooks.PreToolUse[1], { matcher: "^ask_user_question$", hooks: [{
      type: "command", command: "test -f /opt/hommies/dist/grok-hook.js && node /opt/hommies/dist/grok-hook.js question || true", timeout: 305,
    }] });
    assert.deepEqual(Object.keys(grokConfig.hooks).sort(), ["PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopCancelled", "StopFailure", "UserPromptSubmit"]);
    assert.equal(grokConfig.hooks.PreToolUse[0].matcher, undefined, "no matcher: every tool");

    const checks = await checkHooks(environment, providers);
    assert.deepEqual(checks.map((check) => check.status), ["current", "current", "current"]);
    assert.deepEqual((await runSetup({ uninstall: false, dryRun: false, providers }, environment)).map((result) => result.status),
      ["unchanged", "unchanged", "unchanged"]);

    await runSetup({ uninstall: true, dryRun: false, providers }, environment);
    assert.deepEqual(JSON.parse(await readFile(gemini, "utf8")),
      { theme: "dark", hooks: { BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "lint.sh" }] }] } });
    assert.deepEqual(JSON.parse(await readFile(antigravity, "utf8")), { "their-hook": { enabled: true, Stop: [{ type: "command", command: "say done" }] } });
    assert.deepEqual(JSON.parse(await readFile(grok, "utf8")), {});
  });
});

test("the bridge accepts activity and turn ends from the new agents, but not permissions", async () => {
  await withServer(async ({ request }) => {
    for (const provider of ["gemini", "antigravity", "grok"]) {
      const session = `${provider}-1`;
      assert.equal((await request("POST", `/v1/providers/${provider}/activity`, {
        hook_event_name: "PreToolUse", session_id: session, cwd: "/w/app", tool_name: "Bash", tool_input: { command: "make" },
      })).status, 200);
      assert.equal((await request("POST", `/v1/providers/${provider}/stop`, {
        hook_event_name: "Stop", session_id: session, cwd: "/w/app", last_assistant_message: "Done.",
      })).status, 200);
      assert.equal((await request("POST", `/v1/providers/${provider}/failure`, {
        hook_event_name: "StopFailure", session_id: `${session}-f`, error: "rate_limit",
      })).status, 200);
      assert.equal((await request("POST", `/v1/providers/${provider}/permission`, { session_id: session })).status, 404);
    }
    const snapshot = await pending(request);
    const providers = new Set(snapshot.sessions.map((session) => session.provider));
    assert.deepEqual([...providers].sort(), ["antigravity", "gemini", "grok"]);
    const titles = snapshot.threads.map((thread) => thread.title).sort();
    assert.ok(titles.includes("Gemini CLI — app"), titles.join(", "));
    assert.ok(titles.includes("Grok Build — app"), titles.join(", "));
    // Custom agents can no longer take these names.
    assert.equal((await request("POST", "/v1/agents/gemini/activity", { hook_event_name: "SessionStart", session_id: "z" })).status, 400);
  });
});

test("the compiled hooks report to their provider and print what each agent expects", async () => {
  await withServer(async ({ request, dataDir }) => {
    const env = { HOMMIES_DATA_DIR: dataDir };

    const gemini = await runHook("gemini-hook.js", [], {
      hook_event_name: "BeforeTool", session_id: "g9", cwd: "/w/app", tool_name: "run_shell_command", tool_input: { command: "pytest" },
    }, env);
    assert.equal(gemini, "{}\n", "Gemini reads a JSON object from stdout");

    const agy = await runHook("antigravity-hook.js", ["PostToolUse"], {
      conversationId: "a9", workspacePaths: ["/w/app"], toolCall: { name: "run_command", args: { CommandLine: "make" } }, error: "",
    }, env);
    assert.equal(agy, "{}\n");

    const grok = await runHook("grok-hook.js", [], { workspaceRoot: "/w/app", toolName: "Bash", toolInput: { command: "ls" } },
      { ...env, GROK_HOOK_EVENT: "PreToolUse", GROK_SESSION_ID: "x9" });
    assert.equal(grok, "", "Grok: no stdout, so no decision");

    const sessions = Object.fromEntries((await pending(request)).sessions.map((session) => [session.threadId, [session.provider, session.steps]]));
    assert.deepEqual(sessions, {
      g9: ["gemini", ["run_shell_command pytest"]],
      a9: ["antigravity", ["run_command make"]],
      x9: ["grok", ["Bash ls"]],
    });

    // Without a bridge the JSON agents still get their `{}`.
    assert.equal(await runHook("gemini-hook.js", [], { hook_event_name: "BeforeTool", session_id: "g0" }, { HOMMIES_DATA_DIR: join(dataDir, "none") }), "{}\n");
  });
});

test("Antigravity answers from the bar become a deny reason the model reads", () => {
  const reply = antigravityAnswerReply({ answers: [{ question: "Which color?", answer: "Blue" }, { question: "Size?", answer: "" }] });
  assert.equal(reply.decision, "deny");
  assert.match(reply.reason, /already answered this in Hommies/);
  assert.match(reply.reason, /- Which color\? \u2192 Blue/);
  assert.doesNotMatch(reply.reason, /Size\?/, "unanswered questions are left out");
  assert.equal(antigravityAnswerReply({}), null, "no answers: allow, so Antigravity asks itself");
  assert.equal(antigravityAnswerReply({ answers: [{ question: "Q", answer: " " }] }), null);
});

test("with the top-bar surface the bridge holds an Antigravity question until the bar answers", async () => {
  await withServer(async ({ request }) => {
    const reply = request("POST", "/v1/providers/antigravity/question", {
      hook_event_name: "PreToolUse", session_id: "a-6", tool_name: "AskUserQuestion", tool_use_id: "a-6:2",
      tool_input: { questions: [{ question: "Which color?", header: "Question", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] },
    });
    let item;
    for (let attempt = 0; attempt < 50 && !item; attempt++) {
      item = (await pending(request)).threads[0]?.items[0];
      if (!item) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(item.answerSurface, "topbar");
    await request("POST", "/v1/respond", { threadId: "a-6", requestId: item.id, answers: { "Which color?": "Blue" } });
    assert.deepEqual(await (await reply).json(), { answers: [{ question: "Which color?", answer: "Blue" }] });
  });
});

test("with the CLI surface Antigravity questions are mirrored read-only and clear on its next tool call", async () => {
  await withServer(async ({ request }) => {
    await request("POST", "/v1/preferences", { questionAnswerSurface: "cli" });
    const ask = {
      hook_event_name: "PreToolUse", session_id: "a-8", tool_name: "AskUserQuestion", tool_use_id: "a-8:2",
      tool_input: { questions: [{ question: "Which color?", header: "Question", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }] },
    };
    const response = await request("POST", "/v1/providers/antigravity/question", ask);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {}, "no answer: Antigravity's own UI asks");
    const item = (await pending(request)).threads[0].items[0];
    assert.equal(item.kind, "question");
    assert.equal(item.answerSurface, "cli");
    assert.deepEqual(item.questions[0].options.map((option) => option.label), ["Red", "Blue"]);

    await request("POST", "/v1/providers/antigravity/activity", {
      hook_event_name: "PreToolUse", session_id: "a-8", tool_name: "ask_question", tool_input: {},
    });
    assert.equal((await pending(request)).totalCount, 0, "answered in Antigravity, so it leaves the bar");
  });
});

test("an interrupted turn sets the session idle without a finished item", async () => {
  await withServer(async ({ request }) => {
    await request("POST", "/v1/providers/grok/resume", { hook_event_name: "UserPromptSubmit", session_id: "x-9", cwd: "/w/app", prompt: "go" });
    await request("POST", "/v1/providers/grok/activity", { hook_event_name: "PreToolUse", session_id: "x-9", tool_name: "run_terminal_command", tool_input: { command: "sleep 9" } });
    await request("POST", "/v1/providers/grok/activity", { hook_event_name: "StopCancelled", session_id: "x-9" });
    const snapshot = await pending(request);
    assert.equal(snapshot.totalCount, 0);
    assert.equal(snapshot.sessions[0].state, "idle");
    assert.equal(snapshot.sessions[0].steps.at(-1), "(interrupted)");
  });
});

test("the compiled Antigravity question hook allows ask_question unless the bar answered", async () => {
  await withServer(async ({ dataDir, request }) => {
    await request("POST", "/v1/preferences", { questionAnswerSurface: "cli" });
    const payload = { conversationId: "a-9", stepIdx: 1, workspacePaths: [], toolCall: { name: "ask_question", args: { questions: [{ question: "Q?", options: ["A"] }] } } };
    assert.equal(await runHook("antigravity-hook.js", ["PreToolUse"], payload, { HOMMIES_DATA_DIR: dataDir }), '{"decision":"allow"}\n');
    assert.equal((await pending(request)).threads[0].items[0].summary, "Q?");
    assert.equal(await runHook("antigravity-hook.js", ["PreToolUse"], payload, { HOMMIES_DATA_DIR: join(dataDir, "none") }), '{"decision":"allow"}\n',
      "still allowed with no bridge");
  });
});

test("the compiled Grok question hook relays a bar answer, and stays silent otherwise", async () => {
  await withServer(async ({ dataDir, request }) => {
    const payload = {
      hook_event_name: "PreToolUse", hookEventName: "pre_tool_use", session_id: "g-5", tool_name: "ask_user_question", tool_use_id: "c-5",
      tool_input: { questions: [{ question: "Which color?", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] },
    };
    const env = { HOMMIES_DATA_DIR: dataDir, GROK_HOOK_EVENT: "pre_tool_use" };
    const hook = runHook("grok-hook.js", ["question"], payload, env);
    let item;
    for (let attempt = 0; attempt < 100 && !item; attempt++) {
      item = (await pending(request)).threads[0]?.items[0];
      if (!item) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await request("POST", "/v1/respond", { threadId: "g-5", requestId: item.id, answers: { "Which color?": "Blue" } });
    const output = JSON.parse(await hook);
    assert.equal(output.decision, "deny");
    assert.match(output.reason, /"Which color\?"="Blue"/);

    await request("POST", "/v1/preferences", { questionAnswerSurface: "cli" });
    assert.equal(await runHook("grok-hook.js", ["question"], { ...payload, tool_use_id: "c-6" }, env), "", "CLI surface: Grok asks itself");
  });
});

test("the Claude hook stays silent when Grok Build runs it", async () => {
  await withServer(async ({ request, dataDir }) => {
    const stdout = await runHook("claude-hook.js", [], {
      hook_event_name: "PreToolUse", session_id: "c9", cwd: "/w/app", tool_name: "Bash", tool_input: { command: "ls" },
    }, { HOMMIES_DATA_DIR: dataDir, GROK_HOOK_EVENT: "PreToolUse" });
    assert.equal(stdout, "");
    assert.deepEqual((await pending(request)).sessions, []);
  });
});

function runHook(script, args, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, script), ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "hommies-foreign-setup-"));
  try {
    await run({ home, environment: { home, env: {}, distDir: "/opt/hommies/dist" } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function pending(request) {
  return request("GET", "/v1/pending").then((response) => response.json());
}

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-foreign-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
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
