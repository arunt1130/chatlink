import type { Event } from "../events/schema";
import type { Skipped } from "../events/reader";

export type SyncState = {
  /** ISO time of the last successful pull, if any. */
  lastPullAt: string | null;
  /** True when the latest pull failed or none has succeeded in this process. */
  stale: boolean;
  /** My commits not yet delivered to the remote (the offline queue). */
  unpushed: number;
  /** My log lines are on disk but a commit failed; they will be committed on a later cycle. */
  uncommitted: boolean;
  lastPushAt: string | null;
  lastError: string | null;
};

export type FetchResult = {
  /** Events from log files that changed since `since` (all logs if none). May include ones already seen; ingest is idempotent. */
  events: Event[];
  skipped: Skipped[];
  /** Opaque cursor to pass as `since` next time. */
  cursor: string;
  sync: SyncState;
};

export type AppendMineResult = { written: number; committed: boolean };

/**
 * The transport boundary. Git implements it now; a Drive transport can later.
 * "Append my events" and "fetch everyone's new events".
 */
export interface Transport {
  /** Durably writes my events locally, then queues them for delivery (never waits on the network). */
  appendMine(events: readonly Event[]): Promise<AppendMineResult>;
  /** Brings in everyone's new events, falling back to local data when offline. */
  fetchNew(since?: string): Promise<FetchResult>;
  syncState(): Promise<SyncState>;
  /** Resolves when no background delivery is running. */
  whenIdle(): Promise<void>;
}
