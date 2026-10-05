/**
 * Bounded reads of files the hooks did not create (agent transcripts, files an
 * agent is editing) and the opt-in debug log. Each file is opened once and
 * checked through that descriptor, so a path swapped after a check cannot
 * change what is read or written.
 */
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";

/** O_NONBLOCK: opening a FIFO for reading returns at once instead of waiting for a writer. */
const readFlags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

/**
 * Reads at most `maxBytes` of a regular file: its start (`head`), its end
 * (`tail`), or all of it (`whole`, which is null when the file is larger).
 * Null for anything that is not a regular file (FIFO, device, directory) and
 * for any error.
 */
export async function readRegularFile(path: string, maxBytes: number, from: "head" | "tail" | "whole"): Promise<string | null> {
  if (path.length === 0 || maxBytes < 0) return null;
  try {
    const file = await open(path, readFlags);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return null;
      if (from === "whole") {
        if (stat.size > maxBytes) return null;
        // Read one byte past the limit: a file that grew since fstat is rejected, not truncated.
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await file.read(buffer, 0, maxBytes + 1, 0);
        return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead).toString("utf8");
      }
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, from === "tail" ? stat.size - length : 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/**
 * Appends `text` to a private file, creating it owner-only (0600). Refuses a
 * symlink, anything but a regular file, a file owned by another user, and a
 * file that group or others can access, so private text never lands somewhere
 * another local user can read. Returns whether it wrote.
 */
export function appendPrivateFile(path: string, text: string): boolean {
  if (path.length === 0) return false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY, 0o600);
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return false;
    writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
