/** Command-hook adapter for Codex PermissionRequest events. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface PortFile { readonly port: number; readonly token: string; }

async function main(): Promise<void> {
  const input = await readStdin();
  const dataDir = process.env.AGENT_FOLD_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-fold");
  let connection: PortFile;
  try { connection = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8")) as PortFile; } catch { return; }
  if (!Number.isInteger(connection.port) || typeof connection.token !== "string") return;
  try {
    const response = await fetch(`http://127.0.0.1:${connection.port}/v1/providers/codex/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-fold-token": connection.token },
      body: input,
      signal: AbortSignal.timeout(5 * 60 * 1000 + 5_000),
    });
    if (response.ok) process.stdout.write(await response.text());
  } catch {
    // Keep the native approval prompt when the optional bridge is unavailable.
  }
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

void main();
