import fs from "fs";
import path from "path";

/**
 * Small JSON files under data/ that more than one process may touch (the
 * Telegram, Discord and Slack bots and the keepers share one volume).
 *
 * - Writes go to a temp file and are renamed into place, so a reader or
 *   a crash never sees a half-written file.
 * - updateJson holds a lock file (<file>.lock, created exclusively)
 *   around read-modify-write, so two processes' changes can't overwrite
 *   each other. A lock older than LOCK_STALE_MS is from a process that
 *   died mid-update and is taken over.
 *
 * Synchronous on purpose: callers (db.js) are synchronous, and holding
 * the lock across an await would let other work in this process run
 * while it's held.
 */

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return structuredClone(fallback);
    throw err;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx"));
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
    } catch {
      continue; // released between our open and stat
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lockFile}`);
    sleepSync(wait);
  }
}

/** Re-reads `file` under the lock, lets `mutate` edit it in place, writes it back. Returning false skips the write. */
export function updateJson(file, fallback, mutate) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  acquireLock(lockFile);
  try {
    const data = readJson(file, fallback);
    if (mutate(data) !== false) writeJsonAtomic(file, data);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}
