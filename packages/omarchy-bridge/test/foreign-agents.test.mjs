import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeToolInput, translateAntigravity, translateGemini, translateGrok } from "../dist/foreign-hook.js";
import { checkHooks, runSetup } from "../dist/setup.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("tool arguments are renamed to the fields steps are labelled with", () => {
  assert.deepEqual(normalizeToolInput({ CommandLine: "ls", Cwd: "/w" }), { command: "ls" });
  assert.deepEqual(normalizeToolInput({ TargetFile: "/w/a.ts", CodeContent: "x" }), { file_path: "/w/a.ts" });
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

test("Antigravity events come from the hook argument", () => {
  const base = { conversationId: "a1", workspacePaths: ["/w/app", "/w/lib"], transcriptPath: "/t", modelName: "m" };
  assert.deepEqual(translateAntigravity({ ...base, toolCall: { name: "run_command", args: { CommandLine: "make" } }, stepIdx: 3, error: "" }, "PostToolUse"),
    { session_id: "a1", cwd: "/w/app", hook_event_name: "PreToolUse", tool_name: "run_command", tool_input: { command: "make" } });
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
      PostToolUse: [{ matcher: "*", hooks: [{
        type: "command", command: "test -f /opt/hommies/dist/antigravity-hook.js && node /opt/hommies/dist/antigravity-hook.js PostToolUse || echo '{}'", timeout: 5,
      }] }],
      Stop: [{ type: "command", command: "test -f /opt/hommies/dist/antigravity-hook.js && node /opt/hommies/dist/antigravity-hook.js Stop || echo '{}'", timeout: 5 }],
    });

    const grokConfig = JSON.parse(await readFile(grok, "utf8"));
    assert.deepEqual(Object.keys(grokConfig.hooks).sort(), ["PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
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
