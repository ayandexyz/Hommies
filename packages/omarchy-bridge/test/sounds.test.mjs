import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startBridgeServer } from "../dist/server.js";

test("sounds are off until the preference turns them on", async () => {
  const played = [];
  await withServer({ playSound: (sound) => played.push(sound) }, async ({ request }) => {
    await request("POST", "/v1/providers/claude/stop", { hook_event_name: "Stop", session_id: "a", last_assistant_message: "Done." });
    assert.deepEqual(played, []);

    const preferences = await (await request("POST", "/v1/preferences", { sounds: true })).json();
    assert.equal(preferences.sounds, true);
    await request("POST", "/v1/providers/claude/stop", { hook_event_name: "Stop", session_id: "b", last_assistant_message: "Done." });
    await request("POST", "/v1/providers/claude/stop", { hook_event_name: "Stop", session_id: "c", last_assistant_message: "Should I push?" });
    await request("POST", "/v1/providers/claude/failure", { session_id: "d", error: "server_error" });
    await request("POST", "/v1/providers/claude/failure", { session_id: "e", error: "rate_limit" });
    assert.deepEqual(played, ["finished", "attention", "error", "attention"]);

    assert.equal((await request("POST", "/v1/preferences", { sounds: "yes" })).status, 400);
    await request("POST", "/v1/preferences", { sounds: false, desktopNotifications: false });
    await request("POST", "/v1/providers/claude/stop", { hook_event_name: "Stop", session_id: "f", last_assistant_message: "Done." });
    assert.equal(played.length, 4);
  });
});

test("the packaged sound files exist", async () => {
  for (const name of ["attention", "error", "finished"]) {
    await access(fileURLToPath(new URL(`../sounds/${name}.wav`, import.meta.url)));
  }
});

async function withServer(options, run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-sounds-test-"));
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
