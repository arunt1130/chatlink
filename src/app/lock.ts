import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * One chatlink process per clone. Git operations in one process are
 * serialized, and the M1 timeout recovery removes stale git lock files; both
 * are only safe if no other chatlink process works on the same clone. The lock
 * lives in the clone's .git folder (never committed), so it holds whatever
 * state folder each process uses. It is named *.pid, not *.lock, so the git
 * lock cleanup after a timed-out pull can never remove it.
 *
 * A new process waits briefly for an old one (Claude Desktop may restart a
 * server while the previous one is still finishing a push), takes over a lock
 * whose process is gone, and otherwise refuses with a clear message.
 */
export class LockedError extends Error {
  override name = "LockedError";
}

export type ServerLock = { file: string; release(): void };

/** Name of the per-clone lock file inside the git dir. Not "*.lock": see above. */
export const SERVER_LOCK_FILE = "chatlink-server.pid";

function gitDir(repo: string): string {
  const dotGit = path.join(repo, ".git");
  try {
    if (statSync(dotGit).isFile()) {
      // A worktree or submodule: ".git" is a file pointing at the real git dir.
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (m) return path.resolve(repo, m[1]!.trim());
    }
  } catch {
    /* fall through */
  }
  return dotGit;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function acquireServerLock(repo: string, opts: { waitMs?: number; what?: string } = {}): ServerLock {
  const file = path.join(gitDir(repo), SERVER_LOCK_FILE);
  const deadline = Date.now() + (opts.waitMs ?? 6000);
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let released = false;
      return {
        file,
        release() {
          if (released) return;
          released = true;
          try {
            if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    } catch {
      continue; // vanished between open and read: try again
    }
    if (holder === process.pid || !alive(holder)) {
      // Stale: its process is gone (or it's ours from an unclean reopen). Re-read
      // right before removing, so we don't delete a lock another process just took
      // over (a small race remains; the loser's O_EXCL create then fails and it waits).
      try {
        if (Number.parseInt(readFileSync(file, "utf8").trim(), 10) === holder) unlinkSync(file);
      } catch {
        /* gone already: loop decides */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockedError(
        `another chatlink process (pid ${holder}) is already using ${repo}. ` +
          `Only one may run per clone: quit Claude Desktop (or turn the chatlink extension off) before running ${opts.what ?? "this"}, ` +
          `or give each server entry its own clone. If nothing else is running (e.g. after a crash), delete ${file} and try again.`,
      );
    }
    sleepSync(200);
  }
}
