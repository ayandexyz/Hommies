import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { connectToOwnBridge, responseProof, serverSocketUid, validProof } from "../dist/bridge-identity.js";
import { postToBridge } from "../dist/hook-common.js";
import { startBridgeServer } from "../dist/server.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

const permission = {
  hook_event_name: "PermissionRequest", session_id: "s1", cwd: "/home/me/project",
  tool_name: "Bash", tool_input: { command: "cat ~/.ssh/id_ed25519" },
};
const grant = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });

test("the server end of a loopback connection is matched by both ports", () => {
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 1 1",
    "   1: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 2 1",
    "   2: 0100007F:D431 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 3 1",
  ].join("\n");
  assert.equal(serverSocketUid(table, 0x1f90, 0xd431), 1001, "the accepted socket, not our own end");
  assert.equal(serverSocketUid(table, 0x1f90, 0xd432), null);
});

test("a port held by another user gets no bytes at all", async () => {
  let received = 0;
  const impostor = createTcpServer((socket) => socket.on("data", (chunk) => { received += chunk.length; }));
  await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
  const port = impostor.address().port;
  // The real table, with every uid replaced: what another user's listener looks like.
  const otherUser = () => readFileSync("/proc/net/tcp", "utf8").split("\n")
    .map((line, index) => index === 0 ? line : line.replace(/^(\s*\S+(?:\s+\S+){6}\s+)\d+/, "$199999")).join("\n");
  try {
    await assert.rejects(connectToOwnBridge(port, otherUser), /not held by this user/);
    await assert.rejects(connectToOwnBridge(port, () => { throw new Error("no /proc"); }), /no \/proc/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received, 0);
    // Our own listener passes.
    const socket = await connectToOwnBridge(port);
    socket.destroy();
  } finally {
    impostor.close();
  }
});

test("a stale port.json pointing at an impostor yields no decision", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-identity-"));
  const requests = [];
  // Holds the freed port and answers every request with a permission grant.
  const impostor = createHttpServer((request, response) => {
    requests.push(request.headers);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json", "x-hommies-proof": "forged" });
      response.end(grant);
    });
  });
  await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
  try {
    const port = impostor.address().port;
    await writeFile(join(dataDir, "port.json"), JSON.stringify({ port, token: "t", version: 1, pid: 1, serverKey: "real-key" }));
    for (const script of ["claude-hook.js", "codex-hook.js"]) {
      assert.equal(await runHook(script, permission, { HOMMIES_DATA_DIR: dataDir }), "", `${script} must keep the native prompt`);
    }
    assert.equal(requests.length, 2, "same-user impostors are reached; only the proof stops them");
  } finally {
    impostor.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the real bridge's decision still reaches the agent", async () => {
  await withBridge(async ({ dataDir, request }) => {
    for (const [script, provider] of [["claude-hook.js", "claude"], ["codex-hook.js", "codex"]]) {
      const hook = runHook(script, { ...permission, session_id: provider }, { HOMMIES_DATA_DIR: dataDir });
      let item;
      while (!item) {
        const snapshot = await (await request("/v1/pending", {})).json();
        item = snapshot.threads.find((thread) => thread.threadId === provider)?.items[0];
        if (!item) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const answer = await request("/v1/respond", { "content-type": "application/json" }, "POST",
        JSON.stringify({ threadId: provider, requestId: item.id, decision: "accept" }));
      assert.equal(answer.status, 200);
      assert.equal(JSON.parse(await hook).hookSpecificOutput.decision.behavior, "allow", script);
    }
  });
});

test("bridge replies are bound to the request nonce and the server key", async () => {
  await withBridge(async ({ connection, request }) => {
    const reply = await postToBridge(connection, "/v1/preferences", JSON.stringify({ sounds: true }), 2_000);
    assert.equal(reply.ok, true);
    assert.equal(JSON.parse(reply.text).sounds, true);

    const nonce = "n".repeat(32);
    const signed = await request("/v1/pending", { "x-hommies-nonce": nonce });
    const body = await signed.text();
    const proof = signed.headers.get("x-hommies-proof");
    assert.ok(validProof(connection.serverKey, nonce, 200, body, proof));
    assert.ok(!validProof(connection.serverKey, "m".repeat(32), 200, body, proof), "a replayed proof fails for another nonce");
    assert.ok(!validProof("other-key", nonce, 200, body, proof), "the key is what makes it unforgeable");
    assert.ok(!validProof(connection.serverKey, nonce, 200, body.replace("0", "1"), proof));
    assert.equal(proof, responseProof(connection.serverKey, nonce, 200, body));
    assert.equal((await request("/v1/pending", {})).headers.get("x-hommies-proof"), null, "unsigned without a nonce");

    // A key-less client (an old hook) is still served: the contract stays backward-compatible.
    const legacy = await fetch(`http://127.0.0.1:${connection.port}/v1/pending`, { headers: { "x-hommies-token": connection.token } });
    assert.equal(legacy.status, 200);
  });
});

test("closing the bridge removes its port.json, but never a newer bridge's", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-identity-close-"));
  try {
    const first = await startBridgeServer({ dataDir, port: 0 });
    await first.close();
    await assert.rejects(access(join(dataDir, "port.json")), "a stopped bridge leaves nothing to dial");

    const older = await startBridgeServer({ dataDir, port: 0 });
    const newer = await startBridgeServer({ dataDir, port: 0 });
    await older.close();
    const kept = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    assert.equal(kept.port, newer.port);
    await newer.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
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

async function withBridge(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "hommies-identity-bridge-"));
  const server = await startBridgeServer({ dataDir, port: 0 });
  try {
    const connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8"));
    const request = (path, headers, method = "GET", body = undefined) => fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, body, headers: { "x-hommies-token": connection.token, ...headers },
    });
    await run({ connection, request, dataDir });
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
