/** Names for custom agents reported through `/v1/agents/{name}/...` and `hommies-hook --agent`. */

/** Built-in providers, and the names the contracts reserve for planned ones. */
export const reservedAgentNames: ReadonlyArray<string> = ["claude", "codex", "opencode", "cursor", "grok", "antigravity", "gemini", "freecode"];

/**
 * Lowercase letters, digits, and hyphens, 1-24 characters, and not a reserved
 * name, so a custom agent cannot pose as Claude, Codex, or OpenCode.
 */
export function isValidAgentName(raw: string): boolean {
  return /^[a-z0-9-]{1,24}$/.test(raw) && !reservedAgentNames.includes(raw);
}
