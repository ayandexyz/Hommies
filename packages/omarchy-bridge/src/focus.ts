/**
 * Focuses the Hyprland window an agent session runs in. The adapters send the
 * agent's process ancestry; the nearest ancestor that owns a Hyprland client
 * is the terminal. Inside tmux, the pane is selected first and the terminal
 * is found through the tmux clients attached to the pane's session.
 */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

import { ancestorPids } from "./process-tree.js";

export interface FocusTarget {
  /** The agent process and its ancestors, nearest first. */
  readonly pids: ReadonlyArray<number>;
  readonly tmux?: { readonly socket: string; readonly pane: string };
  /** Text a window title may contain (session title, project folder), used to pick between windows of one process. */
  readonly hints: ReadonlyArray<string>;
}

export interface HyprClient {
  readonly address: string;
  readonly pid: number;
  readonly title: string;
}

export type FocusWindow = (target: FocusTarget) => Promise<boolean>;

/**
 * The window of the nearest ancestor that owns one. Single-instance terminals
 * (kitty, foot server) own many windows with one pid; a title containing a
 * hint wins, otherwise the first one.
 */
export function pickClient(clients: ReadonlyArray<HyprClient>, pids: ReadonlyArray<number>, hints: ReadonlyArray<string>): HyprClient | null {
  for (const pid of pids) {
    const owned = clients.filter((client) => client.pid === pid);
    if (owned.length === 0) continue;
    const lowered = hints.filter((hint) => hint.length > 0).map((hint) => hint.toLowerCase());
    return owned.find((client) => lowered.some((hint) => client.title.toLowerCase().includes(hint))) ?? owned[0] ?? null;
  }
  return null;
}

/** Accepts only what tmux itself puts in `$TMUX` and `$TMUX_PANE`. */
export function validTmux(socket: unknown, pane: unknown): { socket: string; pane: string } | undefined {
  if (typeof socket !== "string" || typeof pane !== "string") return undefined;
  if (!isAbsolute(socket) || socket.length > 512 || !/^%\d+$/.test(pane)) return undefined;
  return { socket, pane };
}

function run(command: string, args: ReadonlyArray<string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 3_000, encoding: "utf8" }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function parseClients(text: string): HyprClient[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value: unknown): HyprClient[] => {
    if (value === null || typeof value !== "object") return [];
    const client = value as Record<string, unknown>;
    if (typeof client.address !== "string" || typeof client.pid !== "number") return [];
    return [{ address: client.address, pid: client.pid, title: typeof client.title === "string" ? client.title : "" }];
  });
}

/** Selects the pane, then returns the ancestry of every tmux client showing its session. */
async function tmuxClientPids(tmux: { readonly socket: string; readonly pane: string }): Promise<number[]> {
  const session = (await run("tmux", ["-S", tmux.socket, "display-message", "-p", "-t", tmux.pane, "#{session_name}"]))?.trim();
  if (!session) return [];
  await run("tmux", ["-S", tmux.socket, "select-window", "-t", tmux.pane]);
  await run("tmux", ["-S", tmux.socket, "select-pane", "-t", tmux.pane]);
  const clients = await run("tmux", ["-S", tmux.socket, "list-clients", "-F", "#{client_pid}\t#{session_name}"]);
  const pids: number[] = [];
  for (const line of (clients ?? "").split("\n")) {
    const [pid, name] = line.split("\t");
    if (name === session && Number.isInteger(Number(pid))) pids.push(...await ancestorPids(Number(pid)));
  }
  return pids;
}

/** The default focuser: `hyprctl` and, for tmux sessions, `tmux`. */
export const focusHyprlandWindow: FocusWindow = async (target) => {
  const pids = target.tmux ? [...await tmuxClientPids(target.tmux), ...target.pids] : target.pids;
  const clients = await run("hyprctl", ["clients", "-j"]);
  if (clients === null) return false;
  const client = pickClient(parseClients(clients), pids, target.hints);
  if (client === null) return false;
  return focusAddress(client.address);
};

/**
 * Hyprland 0.56+ parses `hyprctl dispatch` as Lua (`hl.dsp.focus`); older
 * versions take the `focuswindow` dispatcher. Each answers the other's syntax
 * with an error rather than `ok`, so try the new one, then the old one.
 */
export function focusCommands(address: string): ReadonlyArray<ReadonlyArray<string>> {
  return [
    ["dispatch", `hl.dsp.focus({ window = "address:${address}" })`],
    ["dispatch", "focuswindow", `address:${address}`],
  ];
}

async function focusAddress(address: string): Promise<boolean> {
  // Addresses come from `hyprctl clients -j`; keep them out of the Lua string if they ever look odd.
  if (!/^0x[0-9a-f]+$/i.test(address)) return false;
  for (const args of focusCommands(address)) {
    if ((await run("hyprctl", args))?.trim() === "ok") return true;
  }
  return false;
}
