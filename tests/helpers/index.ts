import path from "node:path";
import { afterEach } from "vitest";
import { type OpenOptions, SqliteIndex } from "../../src";
import { tmpDir } from "./tmp";

const open: SqliteIndex[] = [];

/** Opens (or creates) an index and closes it after the test, before temp dirs are removed. */
export function openIndex(file?: string, opts?: OpenOptions): SqliteIndex {
  const idx = SqliteIndex.open(file ?? path.join(tmpDir("chatlink-idx-"), "index.sqlite"), opts);
  open.push(idx);
  return idx;
}

/** Registers an index opened elsewhere (e.g. by rebuildIndex) for closing. */
export function track(idx: SqliteIndex): SqliteIndex {
  open.push(idx);
  return idx;
}

afterEach(() => {
  for (const idx of open.splice(0)) idx.close();
});
