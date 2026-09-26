/** Command-hook adapter for Claude Code questions and permission requests. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface PortFile { readonly port: number; readonly token: string; }

async function main(): Promise<void> {
  const input = await readStdin();
  let event: { hook_event_name?: string; tool_name?: string };
  try { event = JSON.parse(input) as { hook_event_name?: string; tool_name?: string }; } catch { return; }
  const dataDir = process.env.AGENT_FOLD_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-fold");
  let port: PortFile;
  try { port = JSON.parse(await readFile(join(dataDir, "port.json"), "utf8")) as PortFile; } catch { return; }
  if (!Number.isInteger(port.port) || typeof port.token !== "string") return;
  try {
    const question = event.tool_name === "AskUserQuestion";
    const resolvingQuestion = question &&
      (event.hook_event_name === "PostToolUse" || event.hook_event_name === "PostToolUseFailure");
    const path = resolvingQuestion
      ? "/v1/providers/claude/question/resolved"
      : question
        ? "/v1/providers/claude/question"
        : "/v1/providers/claude/permission";
    const response = await fetch(`http://127.0.0.1:${port.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-agent-fold-token": port.token }, body: input,
      signal: AbortSignal.timeout(5 * 60 * 1000 + 5_000),
    });
    if (response.ok) process.stdout.write(await response.text());
  } catch {
    // The bridge is optional; preserve Claude Code's native permission prompt.
  }
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

void main();
