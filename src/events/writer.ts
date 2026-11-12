import path from "node:path";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { type Event, validateEvent } from "./schema";
import { WriteRefusedError, assertAuthor, assertInsideMyDir, logDirFor, logFileFor } from "./paths";

export type AppendResult = { file: string; count: number }[];

/**
 * Appends events to logs/<me>/<UTC day>.jsonl, one JSON object per line, and
 * fsyncs each file. Refuses (writing nothing) if any event is invalid, is not
 * authored by `me`, or would land outside logs/<me>/.
 */
export function appendEvents(root: string, me: string, events: readonly Event[]): AppendResult {
  assertAuthor(me);
  const byFile = new Map<string, string[]>();
  for (const e of events) {
    const r = validateEvent(e);
    if (!r.ok) throw new WriteRefusedError(`invalid event: ${r.reason}`);
    if (e.author !== me) throw new WriteRefusedError(`refusing to write an event by ${JSON.stringify(e.author)} as ${me}`);
    const file = logFileFor(root, me, e.ts);
    const lines = byFile.get(file) ?? [];
    lines.push(JSON.stringify(e));
    byFile.set(file, lines);
  }
  if (byFile.size === 0) return [];

  const dir = logDirFor(root, me);
  mkdirSync(dir, { recursive: true });
  for (const file of byFile.keys()) assertInsideMyDir(root, me, file);

  const result: AppendResult = [];
  for (const [file, lines] of byFile) {
    appendLines(file, lines);
    result.push({ file, count: lines.length });
  }
  syncDir(dir);
  syncDir(path.dirname(dir)); // logs/ may be new too
  return result;
}

function appendLines(file: string, lines: string[]): void {
  // O_NOFOLLOW (POSIX only) closes the gap between the lstat check and open.
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, flags, 0o644);
  try {
    let prefix = "";
    const size = fstatSync(fd).size;
    if (size > 0) {
      // A crash mid-write can leave a partial last line. Start a fresh line so
      // the new event is never glued onto it.
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    const buf = Buffer.from(prefix + lines.join("\n") + "\n", "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Best effort: makes a new file's directory entry durable. Not supported on Windows. */
function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* ignore */
  }
}
