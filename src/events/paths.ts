import { type Stats, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { AUTHOR_RE, dayOf, isUtcTs } from "./schema";

export class WriteRefusedError extends Error {
  override name = "WriteRefusedError";
}

export const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function assertAuthor(author: string): void {
  if (!AUTHOR_RE.test(author)) throw new WriteRefusedError(`invalid author name: ${JSON.stringify(author)}`);
}

export function logDirFor(root: string, author: string): string {
  assertAuthor(author);
  return path.join(path.resolve(root), "logs", author);
}

export function logFileFor(root: string, author: string, ts: string): string {
  if (!isUtcTs(ts)) throw new WriteRefusedError(`invalid ts: ${JSON.stringify(ts)}`);
  return path.join(logDirFor(root, author), `${dayOf(ts)}.jsonl`);
}

function caseInsensitiveFs(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

function isStrictlyInside(child: string, parent: string): boolean {
  const c = caseInsensitiveFs() ? child.toLowerCase() : child;
  const p = caseInsensitiveFs() ? parent.toLowerCase() : parent;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True if `child` is `parent` or anywhere under it (case-insensitive on win32/darwin). */
export function isInsideOrEqual(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const rel = path.relative(caseInsensitiveFs() ? p.toLowerCase() : p, caseInsensitiveFs() ? c.toLowerCase() : c);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuses unless `target` is inside logs/<me>/, both lexically and after
 * resolving symlinks. logs/<me> must already exist.
 */
export function assertInsideMyDir(root: string, me: string, target: string): void {
  const myDir = logDirFor(root, me);
  const abs = path.resolve(target);
  if (!isStrictlyInside(abs, myDir)) throw new WriteRefusedError(`refusing write outside logs/${me}/: ${target}`);

  // Symlink checks: logs/<me> must really be <realRoot>/logs/<me>, and the
  // target (or its parent, if it doesn't exist yet) must resolve inside it.
  // The root may differ in case on case-insensitive filesystems, but the
  // `logs/<me>` part must match exactly: a pre-existing `logs/ARUN/` would
  // otherwise take arun's writes into a folder readers ignore.
  const realRoot = realpathSync.native(path.resolve(root));
  const realMyDir = realpathSync.native(myDir);
  const realLogs = path.dirname(realMyDir);
  const rootOk = caseInsensitiveFs()
    ? path.dirname(realLogs).toLowerCase() === realRoot.toLowerCase()
    : path.dirname(realLogs) === realRoot;
  if (!rootOk || path.basename(realLogs) !== "logs" || path.basename(realMyDir) !== me) {
    throw new WriteRefusedError(`logs/${me} resolves elsewhere: ${realMyDir}`);
  }

  // The target itself must be a regular file or not exist. A symlink (even a
  // dangling one, which realpath can't resolve) could redirect the write.
  let st: Stats | undefined;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (st && !st.isFile()) throw new WriteRefusedError(`refusing to write through a non-regular file: ${target}`);

  const realTarget = st ? realpathSync.native(abs) : path.join(realpathSync.native(path.dirname(abs)), path.basename(abs));
  if (!isStrictlyInside(realTarget, realMyDir)) {
    throw new WriteRefusedError(`refusing write outside logs/${me}/ (resolves to ${realTarget})`);
  }
}
