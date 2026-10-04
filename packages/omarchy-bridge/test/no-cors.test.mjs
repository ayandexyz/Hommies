import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/server.js";

// Every client (the QML plugin, the hooks, the OpenCode plugin, Omacode) runs
// outside a browser, so the bridge sends no CORS headers: a web page must not
// be allowed to read its responses or preflight a request to it.

test("responses carry no CORS headers", async () => {
  await withServer(async ({ url, token }) => {
    const pending = await fetch(`${url}/v1/pending`, { headers: { "x-agent-fold-token": token } });
    assert.equal(pending.status, 200);
    assert.equal(pending.headers.get("access-control-allow-origin"), null);

    const health = await fetch(`${url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), null);

    const controller = new AbortController();
    const stream = await fetch(`${url}/v1/stream`, { headers: { "x-agent-fold-token": token }, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("access-control-allow-origin"), null);
    controller.abort();
  });
});

test("a browser preflight without the token is refused", async () => {
  await withServer(async ({ url }) => {
    const preflight = await fetch(`${url}/v1/respond`, {
      method: "OPTIONS",
      headers: { origin: "https://example.com", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 401);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal(preflight.headers.get("access-control-allow-headers"), null);
  });
});

async function withServer(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-fold-no-cors-test-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const { token } = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    await run({ url: `http://127.0.0.1:${server.port}`, token });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
