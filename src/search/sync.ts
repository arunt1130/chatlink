import type { Skipped } from "../events/reader";
import type { IngestResult } from "../events/store";
import type { SyncState, Transport } from "../transport/types";
import { type OpenOptions, SqliteIndex, assertIndexPath, deleteIndexFiles } from "./sqliteIndex";

export type IndexSyncResult = { ingest: IngestResult; skipped: Skipped[]; sync: SyncState };

/**
 * Incremental ingest: fetch only what changed since the index's cursor, ingest
 * it, and advance the cursor (one transaction). Works offline: the transport
 * falls back to local data and says so in `sync`.
 */
export async function syncIndex(index: SqliteIndex, transport: Transport): Promise<IndexSyncResult> {
  const r = await transport.fetchNew(index.cursor);
  const ingest = index.ingestAt(r.events, r.cursor);
  return { ingest, skipped: r.skipped, sync: r.sync };
}

/**
 * The rebuild command: deletes the index file, creates a fresh one, and
 * ingests every event from the logs. The index must not be open elsewhere.
 * Returns the new, open index.
 */
export async function rebuildIndex(
  file: string,
  transport: Transport,
  opts: OpenOptions = {},
): Promise<{ index: SqliteIndex } & IndexSyncResult> {
  deleteIndexFiles(assertIndexPath(file, opts.source)); // check first: never delete anything else
  const index = SqliteIndex.open(file, opts);
  try {
    return { index, ...(await syncIndex(index, transport)) };
  } catch (e) {
    index.close();
    throw e;
  }
}
