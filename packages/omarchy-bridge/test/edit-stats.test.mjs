import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { editStats, lineDiff, patchStats } from "../dist/edit-stats.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("lineDiff counts only the lines that changed", () => {
  assert.deepEqual(lineDiff("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n"), { added: 1, removed: 1 });
  assert.deepEqual(lineDiff("", "one\ntwo\n"), { added: 2, removed: 0 });
  assert.deepEqual(lineDiff("one\ntwo", ""), { added: 0, removed: 2 });
  assert.deepEqual(lineDiff("same\n", "same\n"), { added: 0, removed: 0 });
  // A trailing newline alone is not a changed line.
  assert.deepEqual(lineDiff("a\nb", "a\nb\n"), { added: 0, removed: 0 });
  // Lines kept in the middle of a change are not counted (LCS, not prefix/suffix only).
  assert.deepEqual(lineDiff("1\nkeep\n2\n", "A\nkeep\nB\nC\n"), { added: 3, removed: 2 });
});

test("patchStats counts + and - lines of an apply_patch block", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "@@ function main()",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    "*** Add File: notes.md",
    "+hello",
    "*** End Patch",
    "+not counted",
  ].join("\n");
  assert.deepEqual(patchStats(patch), { added: 3, removed: 1 });
  assert.equal(patchStats("ls -la"), null);
  assert.deepEqual(patchStats(`apply_patch <<'EOF'\n${patch}\nEOF`), { added: 3, removed: 1 });
});

test("editStats handles each edit tool and ignores the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hommies-edit-stats-"));
  try {
    const file = join(dir, "app.ts");
    await writeFile(file, "x = 1\ny = 2\nx = 1\nz = 3\n");

    assert.deepEqual(await editStats("Edit", { file_path: file, old_string: "y = 2", new_string: "y = 20\ny2 = 4" }), { added: 2, removed: 1 });
    // replace_all multiplies by how often old_string appears in the file.
    assert.deepEqual(await editStats("Edit", { file_path: file, old_string: "x = 1", new_string: "x = 9", replace_all: true }), { added: 2, removed: 2 });
    assert.deepEqual(await editStats("MultiEdit", {
      file_path: file,
      edits: [{ old_string: "y = 2", new_string: "y = 5" }, { old_string: "z = 3", new_string: "" }, "junk"],
    }), { added: 1, removed: 2 });
    // Write diffs against the file on disk; a new file is all additions.
    assert.deepEqual(await editStats("Write", { file_path: file, content: "x = 1\ny = 2\nx = 1\nz = 3\nw = 4\n" }), { added: 1, removed: 0 });
    assert.deepEqual(await editStats("Write", { file_path: "new.ts", content: "a\nb\n" }, dir), { added: 2, removed: 0 });
    // OpenCode's camelCase arguments.
    assert.deepEqual(await editStats("edit", { filePath: file, oldString: "z = 3", newString: "z = 4" }), { added: 1, removed: 1 });

    assert.equal(await editStats("Bash", { command: "pnpm test" }), null);
    assert.equal(await editStats("Read", { file_path: file }), null);
    assert.equal(await editStats("Edit", { file_path: file }), null);
    assert.equal(await editStats("Edit", null), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the bridge keeps edit counts aligned with steps and drops bad ones", async () => {
  await withServer(async ({ request }) => {
    const activity = (body) => request("POST", "/v1/providers/claude/activity", { hook_event_name: "PreToolUse", session_id: "e1", cwd: "/w/app", ...body });

    await activity({ tool_name: "Bash", tool_input: { command: "ls" } });
    let session = (await pending(request)).sessions[0];
    assert.equal(session.stepEdits, undefined, "absent until a step is an edit");

    await activity({ tool_name: "Edit", tool_input: { file_path: "/w/app/a.ts" }, edit: { added: 12, removed: 3 } });
    await activity({ tool_name: "Edit", tool_input: { file_path: "/w/app/b.ts" }, edit: { added: -1, removed: 3 } });
    await activity({ tool_name: "Edit", tool_input: { file_path: "/w/app/c.ts" }, edit: { added: 1.5, removed: "2" } });
    session = (await pending(request)).sessions[0];
    assert.deepEqual(session.steps, ["Bash ls", "Edit a.ts", "Edit b.ts", "Edit c.ts"]);
    assert.deepEqual(session.stepEdits, [null, { added: 12, removed: 3 }, null, null]);

    for (let index = 0; index < 25; index++) {
      await activity({ tool_name: "Edit", tool_input: { file_path: `/w/app/f${index}.ts` }, edit: { added: index, removed: 0 } });
    }
    session = (await pending(request)).sessions[0];
    assert.equal(session.stepEdits.length, session.steps.length);
    assert.deepEqual(session.stepEdits.at(-1), { added: 24, removed: 0 });
    assert.equal(session.steps.at(-1), "Edit f24.ts");
  });
});

test("the compiled Claude hook sends counts, not the edited text", async () => {
  await withServer(async ({ request, dataDir }) => {
    const secret = "TOP_SECRET_LINE";
    const stdout = await runHook("claude-hook.js", {
      hook_event_name: "PreToolUse", session_id: "h1", cwd: "/w/app", tool_name: "Edit",
      tool_input: { file_path: "/w/app/src/server.ts", old_string: "a\nb", new_string: `a\n${secret}\nc` },
    }, { HOMMIES_DATA_DIR: dataDir });
    assert.equal(stdout, "");
    const snapshot = await pending(request);
    assert.deepEqual(snapshot.sessions[0].steps, ["Edit server.ts"]);
    assert.deepEqual(snapshot.sessions[0].stepEdits, [{ added: 2, removed: 1 }]);
    assert.ok(!JSON.stringify(snapshot).includes(secret));
  });
});

function runHook(script, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dist, script)], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function pending(request) {
  return request("GET", "/v1/pending").then((response) => response.json());
}

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-edit-stats-test-"));
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
