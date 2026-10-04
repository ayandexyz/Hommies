/**
 * Proves, in both directions, that a client is talking to the bridge that
 * wrote `port.json`, and not to whatever process holds that loopback port
 * now. When the bridge stops, its port is free for any local user to bind,
 * and a crash leaves `port.json` behind.
 *
 * - Before a client sends anything, it checks that the server end of its own
 *   TCP connection belongs to the same uid (`/proc/net/tcp`). Another local
 *   user's listener never receives the token or any hook data.
 * - Every bridge response carries `x-hommies-proof`: an HMAC, keyed with the
 *   `serverKey` from `port.json`, over the client's per-request nonce, the
 *   status, and the body. The key never goes over the wire, so a forged or
 *   replayed response (a permission grant, say) does not verify.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";

export const nonceHeader = "x-hommies-nonce";
export const proofHeader = "x-hommies-proof";

/** base64url, long enough to never repeat, short enough to bound the work. */
export const validNonce = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);

export function responseProof(serverKey: string, nonce: string, status: number, body: string): string {
  return createHmac("sha256", serverKey).update(`${nonce}\n${status}\n${body}`).digest("base64url");
}

export function validProof(serverKey: string, nonce: string, status: number, body: string, proof: unknown): boolean {
  if (typeof proof !== "string") return false;
  const expected = Buffer.from(responseProof(serverKey, nonce, status, body));
  const actual = Buffer.from(proof);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 127.0.0.1 as `/proc/net/tcp` prints it, on little- and big-endian machines. */
const loopbackHex = ["0100007F", "7F000001"];
const portHex = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");

/**
 * The uid that owns the server end of the loopback connection from
 * `localPort` to `port`, from a `/proc/net/tcp` table, or `null` if the
 * table has no such row. An accepted socket keeps its listener's uid.
 */
export function serverSocketUid(table: string, port: number, localPort: number): number | null {
  const server = loopbackHex.map((address) => `${address}:${portHex(port)}`);
  const client = loopbackHex.map((address) => `${address}:${portHex(localPort)}`);
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [, local, remote, , , , , uid] = fields;
    if (local === undefined || remote === undefined || uid === undefined) continue;
    if (server.includes(local) && client.includes(remote) && /^\d+$/.test(uid)) return Number(uid);
  }
  return null;
}

/**
 * Connects to `127.0.0.1:port` and resolves only once the server end is
 * known to belong to this user. Anything it cannot verify (another uid, no
 * `/proc`, no `getuid`) is refused: callers then behave as if the bridge were
 * not running.
 */
export function connectToOwnBridge(port: number, readTable: () => string = () => readFileSync("/proc/net/tcp", "utf8")): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      try {
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        const owner = socket.localPort === undefined ? null : serverSocketUid(readTable(), port, socket.localPort);
        if (uid === null || owner !== uid) throw new Error("the bridge port is not held by this user");
        resolve(socket);
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
