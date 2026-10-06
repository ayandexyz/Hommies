/**
 * Helpers shared by the OpenCode V1 plugin (`opencode-plugin.ts`) and the
 * OpenCode V2 plugin (`opencode-v2/server.ts`). Both speak the same
 * `/v1/providers/opencode/*` protocol to the bridge.
 *
 * Kept out of the plugin modules themselves: OpenCode V1 calls every export
 * of a plugin module as a plugin.
 */
import { postToBridge, readConnection } from "./hook-common.js";

export const hookTimeoutMs = 5 * 60 * 1000 + 5_000;
export const turnTimeoutMs = 2_000;
/** OpenCode names sessions like this until it has generated a title. */
export const placeholderTitle = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}

/** POSTs to the bridge; `null` when it is not running or did not answer. */
export async function sendToBridge(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const connection = await readConnection();
  if (connection === null) return null;
  const response = await postToBridge(connection, path, JSON.stringify(body), timeoutMs);
  return response.ok ? JSON.parse(response.text) as unknown : null;
}

/** OpenCode tool args use camelCase; the bridge labels steps from these snake_case fields. */
export function stepDetail(args: unknown): Record<string, string> {
  if (!isRecord(args)) return {};
  const fields: Record<string, unknown> = {
    command: args.command,
    file_path: args.filePath ?? args.file_path,
    path: args.path,
    pattern: args.pattern,
    query: args.query,
    url: args.url,
    description: args.description,
  };
  const detail: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) if (typeof value === "string") detail[key] = value.slice(0, 300);
  return detail;
}

export function decisionOf(result: unknown): "allow" | "always" | "deny" | null {
  if (!isRecord(result) || !isRecord(result.hookSpecificOutput)) return null;
  const decision = result.hookSpecificOutput.decision;
  if (!isRecord(decision)) return null;
  if (decision.behavior === "allow") return decision.remember === true ? "always" : "allow";
  return decision.behavior === "deny" ? "deny" : null;
}

export function answersOf(result: unknown): string[][] | null {
  if (!isRecord(result) || !Array.isArray(result.answers)) return null;
  const answers = result.answers.filter((answer): answer is string[] =>
    Array.isArray(answer) && answer.every((label) => typeof label === "string"));
  return answers.length === result.answers.length ? answers : null;
}
