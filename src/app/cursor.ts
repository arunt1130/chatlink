import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SqliteIndex } from "../search/sqliteIndex";

/**
 * "What I have already seen" for whats_new. Local only (state dir), never shared.
 *
 * `seq` is a position in the index's ingest order, so an event that arrives
 * late (someone was offline) still counts as new even if its ts is old. A
 * sequence number is only meaningful for the index epoch it came from.
 *
 * After a rebuild (new epoch) the rebuilt rows are in author-folder order, not
 * time order, so no single position is right. The cursor then carries a
 * `floor`: rebuilt rows (seq ≤ upToSeq) are new only if newer than `ts`, the
 * newest ts already seen; rows ingested after the rebuild are new as usual.
 */
export type ReadCursor = { epoch: string; seq: number; ts: number; floor?: { upToSeq: number; afterTsMs: number } };
export type Position = { seq: number; floor?: { upToSeq: number; afterTsMs: number } };

const FILE = "read-cursor.json";

export class ReadCursorStore {
  constructor(private readonly stateDir: string) {}

  load(): ReadCursor | null {
    try {
      const o = JSON.parse(readFileSync(path.join(this.stateDir, FILE), "utf8")) as Partial<ReadCursor>;
      if (typeof o.epoch === "string" && typeof o.seq === "number" && typeof o.ts === "number") {
        const c: ReadCursor = { epoch: o.epoch, seq: o.seq, ts: o.ts };
        if (o.floor && typeof o.floor.upToSeq === "number" && typeof o.floor.afterTsMs === "number") c.floor = o.floor;
        return c;
      }
    } catch {
      /* none yet, or unreadable: start fresh */
    }
    return null;
  }

  save(c: ReadCursor): void {
    mkdirSync(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c) + "\n");
    renameSync(tmp, file);
  }

  /** Where to read from in this index. A first run starts at 0 (everything is new). */
  position(index: SqliteIndex): Position {
    const c = this.load();
    if (!c) return { seq: 0 };
    if (c.epoch === index.epoch) return c.floor ? { seq: c.seq, floor: c.floor } : { seq: c.seq };
    return { seq: 0, floor: { upToSeq: index.maxSeq, afterTsMs: c.ts } };
  }

  advance(index: SqliteIndex, from: Position, seq: number, newestTs: number): void {
    const prev = this.load();
    const c: ReadCursor = { epoch: index.epoch, seq, ts: Math.max(newestTs, prev?.ts ?? 0) };
    if (from.floor && seq < from.floor.upToSeq) c.floor = from.floor; // still inside the rebuilt rows
    this.save(c);
  }
}
