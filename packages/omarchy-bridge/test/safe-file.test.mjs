import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { editStats } from "../dist/edit-stats.js";
import { appendPrivateFile, readRegularFile } from "../dist/safe-file.js";
import { readTranscriptTail } from "../dist/transcript.js";

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "hommies-safe-file-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Resolves within `ms`, or fails: a blocking open on a FIFO would hang here. */
function within(ms, promise) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`still blocked after ${ms} ms`)), ms))]);
}

test("bounded reads return the requested slice of a regular file", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, "0123456789");
    assert.equal(await readRegularFile(file, 4, "head"), "0123");
    assert.equal(await readRegularFile(file, 4, "tail"), "6789");
    assert.equal(await readRegularFile(file, 10, "whole"), "0123456789");
    assert.equal(await readRegularFile(file, 9, "whole"), null, "a whole read over the limit is refused, not truncated");
    assert.equal(await readRegularFile(join(dir, "missing"), 10, "whole"), null);
    assert.equal(await readRegularFile(dir, 10, "whole"), null, "a directory is not a regular file");
  });
});

test("a FIFO is refused at once instead of blocking the hook", async () => {
  await withDir(async (dir) => {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    assert.equal(await within(2000, readRegularFile(fifo, 1024, "whole")), null);
    assert.equal(await within(2000, readTranscriptTail(fifo)), null, "transcripts too");
    // An edit whose target is a FIFO still gets counted from its own text, without reading the FIFO.
    assert.deepEqual(await within(2000, editStats("Write", { file_path: fifo, content: "a\nb\n" })), { added: 2, removed: 0 });
  });
});

test("a file over the edit-count limit is not read", async () => {
  await withDir(async (dir) => {
    const big = join(dir, "big.txt");
    await writeFile(big, "x\n".repeat(600 * 1024));
    // Over 1 MB: the old content is not read, so a Write counts only its own lines.
    assert.deepEqual(await editStats("Write", { file_path: big, content: "y\n" }), { added: 1, removed: 0 });
  });
});

test("the debug log is created owner-only and refuses unsafe targets", async () => {
  await withDir(async (dir) => {
    const log = join(dir, "hooks.jsonl");
    assert.equal(appendPrivateFile(log, "one\n"), true);
    assert.equal(appendPrivateFile(log, "two\n"), true);
    assert.equal(await readFile(log, "utf8"), "one\ntwo\n");
    assert.equal((await stat(log)).mode & 0o777, 0o600);

    const shared = join(dir, "shared.jsonl");
    await writeFile(shared, "");
    await chmod(shared, 0o644);
    assert.equal(appendPrivateFile(shared, "secret\n"), false, "group/other-readable file refused");
    assert.equal(await readFile(shared, "utf8"), "");

    const target = join(dir, "target.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const link = join(dir, "link.jsonl");
    await symlink(target, link);
    assert.equal(appendPrivateFile(link, "secret\n"), false, "symlink refused");
    assert.equal(await readFile(target, "utf8"), "");

    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    assert.equal(appendPrivateFile(fifo, "secret\n"), false, "FIFO refused");
  });
});
