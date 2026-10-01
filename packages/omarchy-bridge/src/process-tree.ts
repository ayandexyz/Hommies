/** Linux process ancestry from `/proc`, used to find the terminal window an agent runs in. */
import { readFile } from "node:fs/promises";

/** Deep enough for terminal → shell → tmux/ssh → agent → hook shell → hook. */
const maxDepth = 32;

/** Fields the adapters send so the bridge can focus the agent's terminal. */
export interface ProcessFields {
  /** The agent process and its ancestors, nearest first. */
  readonly pids: number[];
  /** `$TMUX_PANE` when the agent runs inside tmux, e.g. `%3`. */
  readonly tmux_pane?: string;
  /** The tmux server socket, the first field of `$TMUX`. */
  readonly tmux_socket?: string;
}

/** The parent pid in a `/proc/<pid>/stat` line, or `null`. `comm` may contain spaces and parens. */
export function parentPid(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const parent = Number(fields[1]);
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

export type StatReader = (pid: number) => Promise<string | null>;

const readStat: StatReader = (pid) => readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);

/** `pid` and its ancestors up to (not including) init, nearest first. Empty off Linux. */
export async function ancestorPids(pid: number, read: StatReader = readStat): Promise<number[]> {
  const chain: number[] = [];
  let current: number | null = pid;
  while (current !== null && current > 1 && chain.length < maxDepth && !chain.includes(current)) {
    chain.push(current);
    const stat = await read(current);
    current = stat === null ? null : parentPid(stat);
  }
  return chain;
}

/** Process fields for an adapter running as a child of the agent (`fromPid` = the agent). */
export async function processFields(fromPid: number, env: Readonly<Record<string, string | undefined>> = process.env): Promise<ProcessFields> {
  const pids = await ancestorPids(fromPid);
  const pane = env.TMUX_PANE;
  const socket = env.TMUX?.split(",")[0];
  return {
    pids,
    ...(pane && socket ? { tmux_pane: pane, tmux_socket: socket } : {}),
  };
}

/** A process by pid and start time, so a reused pid is not mistaken for it. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

/** Commands that only wrap the agent, such as the `sh -c` an agent runs its hooks through. */
const wrapperCommands = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "busybox", "env", "timeout", "nice", "nohup"]);

/** Command name, state, and start time from a `/proc/<pid>/stat` line, or `null`. */
export function statFields(stat: string): { readonly comm: string; readonly state: string; readonly startTime: string } | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  // After `comm`: state is field 3 and starttime is field 22 of proc_pid_stat(5).
  const fields = stat.slice(close + 2).split(" ");
  const state = fields[0];
  const startTime = fields[19];
  return state && startTime ? { comm: stat.slice(open + 1, close), state, startTime } : null;
}

/** The agent in an ancestry: the nearest live process that is not a shell or exec wrapper. */
export async function agentIdentity(pids: ReadonlyArray<number>, read: StatReader = readStat): Promise<ProcessIdentity | null> {
  for (const pid of pids) {
    const stat = await read(pid);
    const fields = stat === null ? null : statFields(stat);
    if (!fields || fields.state === "Z" || wrapperCommands.has(fields.comm)) continue;
    return { pid, startTime: fields.startTime };
  }
  return null;
}

/** Whether the process is still running: same pid, same start time, and not a zombie. */
export async function processRunning(identity: ProcessIdentity, read: StatReader = readStat): Promise<boolean> {
  const stat = await read(identity.pid);
  const fields = stat === null ? null : statFields(stat);
  return fields !== null && fields.state !== "Z" && fields.startTime === identity.startTime;
}

/** Finds an agent's process and later checks it is still running. Tests pass a stub. */
export interface AgentProcessProbe {
  readonly identify: (pids: ReadonlyArray<number>) => Promise<ProcessIdentity | null>;
  readonly running: (identity: ProcessIdentity) => Promise<boolean>;
}

/** Reads `/proc`. Off Linux it finds no process, so no session is dropped. */
export const procAgentProbe: AgentProcessProbe = {
  identify: (pids) => agentIdentity(pids),
  running: (identity) => processRunning(identity),
};
