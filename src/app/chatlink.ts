import { existsSync } from "node:fs";
import path from "node:path";
import type { ChatlinkConfig } from "../config";
import { Model2Vec } from "../embed/model2vec";
import type { Embedder } from "../embed/types";
import { STATUS_VALUES, type StatusValue, isEventId, makeEvent } from "../events/schema";
import { type Item, type SearchHit, SqliteIndex } from "../search/sqliteIndex";
import { syncIndex } from "../search/sync";
import { GitTransport } from "../transport/git";
import type { Transport } from "../transport/types";
import { ReadCursorStore } from "./cursor";
import { type PossibleDecision, detectDecision } from "./decisions";

export const LIMITS = Object.freeze({
  /** Relevant past items returned by sync_turn. */
  relevant: 8,
  /** "New from others" items per sync_turn / whats_new call; the rest wait for the next call. */
  digest: 20,
  whatsNew: 50,
  /** Text shown per item; longer texts are cut (get_item returns the full text). */
  itemChars: 600,
  fullChars: 1_000_000,
  /** search / whats_new skip the pull if one succeeded this recently. sync_turn always pulls. */
  pullCacheMs: 15_000,
  /** How long close() waits for a background push before giving up (commits stay queued). */
  closeWaitMs: 5_000,
});

/** What every tool reports about sync, so Claude can say when results may be stale. */
export type SyncReport = {
  last_pull_at: string | null;
  /** True when the latest pull failed (offline): results may be missing others' newest messages. */
  stale: boolean;
  unpushed_commits: number;
  last_error: string | null;
  search_mode: "hybrid" | "keyword-only";
};

export type Digest = { items: Item[]; more: boolean };

export type SyncTurnResult = {
  /** The logged event, or null when share=false (nothing was written). */
  logged: { id: string; ts: string } | null;
  relevant: Item[];
  new_from_others: Digest;
  possible_decision: PossibleDecision | null;
  sync: SyncReport;
  timing_ms: { pull_and_ingest: number; write: number; search: number; total: number };
};

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const r = this.tail.then(fn, fn);
    this.tail = r.catch(() => {});
    return r;
  }
}

/** A hit without ranking internals: what Claude needs to cite it. */
function asItem(h: SearchHit): Item {
  const { score: _s, match: _m, ...item } = h;
  return item;
}

/**
 * The server's logic, independent of MCP: one instance per (me, clone).
 * Calls are serialized, so the index and the read cursor never race.
 */
export class Chatlink {
  readonly me: string;
  private readonly lock = new Mutex();
  private lastSyncAt = 0;
  private readonly cursor: ReadCursorStore;

  private constructor(
    private readonly cfg: ChatlinkConfig,
    readonly transport: Transport,
    readonly index: SqliteIndex,
    readonly embedder: Embedder | undefined,
    readonly warnings: string[],
    private readonly now: () => number,
  ) {
    this.me = cfg.me;
    this.cursor = new ReadCursorStore(cfg.stateDir);
  }

  static open(cfg: ChatlinkConfig, deps: { transport?: Transport; embedder?: Embedder | null; now?: () => number } = {}): Chatlink {
    const warnings: string[] = [];
    let embedder: Embedder | undefined;
    if (deps.embedder !== undefined) embedder = deps.embedder ?? undefined;
    else if (cfg.modelDir) {
      if (existsSync(path.join(cfg.modelDir, "model.safetensors"))) {
        try {
          embedder = Model2Vec.load(cfg.modelDir);
        } catch (e) {
          warnings.push(`embedding model failed to load (${(e as Error).message}); search is keyword-only`);
        }
      } else warnings.push(`no embedding model at ${cfg.modelDir}; search is keyword-only`);
    }
    const transport =
      deps.transport ??
      new GitTransport({ me: cfg.me, repoPath: cfg.repoPath, stateDir: cfg.stateDir, env: cfg.gitEnv, pullTimeoutMs: cfg.pullTimeoutMs });
    const index = SqliteIndex.open(cfg.indexFile, { source: cfg.repoPath, embedder });
    return new Chatlink(cfg, transport, index, embedder, warnings, deps.now ?? Date.now);
  }

  // ---- tools -------------------------------------------------------------------

  /**
   * The core call, once per turn: pull + ingest, log my message (unless
   * share=false), find relevant past items, and hand over what's new from others.
   */
  syncTurn(args: { message: string; share?: boolean }): Promise<SyncTurnResult> {
    return this.lock.run(async () => {
      const t0 = performance.now();
      await this.syncLocked();
      const t1 = performance.now();

      const message = args.message ?? "";
      const share = args.share !== false;
      let logged: { id: string; ts: string } | null = null;
      if (share && message.trim() !== "") {
        const e = makeEvent(this.me, { kind: "message", text: message }, { now: this.now() });
        await this.transport.appendMine([e]); // durable on disk from here; push runs in the background
        this.index.ingest([e]);
        logged = { id: e.id, ts: e.ts };
      }
      const t2 = performance.now();

      const hits = message.trim()
        ? this.index.search(message, { limit: LIMITS.relevant + 1, now: this.now(), maxTextChars: LIMITS.itemChars }).filter((h) => h.id !== logged?.id)
        : [];
      const relevant = hits.slice(0, LIMITS.relevant);
      const t3 = performance.now();

      const digest = this.takeNewFromOthers(LIMITS.digest);
      return {
        logged,
        relevant: relevant.map(asItem),
        new_from_others: digest,
        // Off the record: no suggestion, since a mark_status reason would carry off-record words into the shared log.
        possible_decision: share ? detectDecision(message, logged?.id ?? null, relevant, this.me) : null,
        sync: await this.report(),
        timing_ms: { pull_and_ingest: ms(t1 - t0), write: ms(t2 - t1), search: ms(t3 - t2), total: ms(performance.now() - t0) },
      };
    });
  }

  search(args: { query: string; author?: string; since?: string; limit?: number }): Promise<{ items: Item[]; sync: SyncReport }> {
    return this.lock.run(async () => {
      await this.syncIfOld();
      const hits = this.index.search(args.query, { author: args.author, since: args.since, limit: args.limit, now: this.now(), maxTextChars: LIMITS.itemChars });
      return { items: hits.map(asItem), sync: await this.report() };
    });
  }

  /** Everything from others since my read cursor (oldest first), then advances it. */
  whatsNew(args: { limit?: number } = {}): Promise<Digest & { sync: SyncReport }> {
    return this.lock.run(async () => {
      await this.syncIfOld();
      const d = this.takeNewFromOthers(Math.min(200, Math.max(1, args.limit ?? LIMITS.whatsNew)));
      return { ...d, sync: await this.report() };
    });
  }

  markStatus(args: { target: string; status: StatusValue; reason: string }): Promise<{ event: Item; sync: SyncReport }> {
    return this.lock.run(async () => {
      if (!isEventId(args.target)) throw new Error(`target must be an event id (from a returned item), got ${JSON.stringify(args.target)}`);
      if (!(STATUS_VALUES as readonly string[]).includes(args.status)) throw new Error(`status must be one of ${STATUS_VALUES.join(", ")}`);
      await this.syncIfOld();
      if (!this.index.has(args.target)) throw new Error(`unknown event id ${args.target}: use an id from sync_turn, search or whats_new`);
      const e = makeEvent(this.me, { kind: "status", target: args.target, status: args.status, reason: String(args.reason ?? "") }, { now: this.now() });
      await this.transport.appendMine([e]);
      this.index.ingest([e]);
      return { event: this.index.item(e.id, LIMITS.itemChars)!, sync: await this.report() };
    });
  }

  addNote(args: { text: string }): Promise<{ event: Item; sync: SyncReport }> {
    return this.lock.run(async () => {
      const text = String(args.text ?? "");
      if (text.trim() === "") throw new Error("text is empty");
      const e = makeEvent(this.me, { kind: "note", text }, { now: this.now() });
      await this.transport.appendMine([e]);
      this.index.ingest([e]);
      return { event: this.index.item(e.id, LIMITS.itemChars)!, sync: await this.report() };
    });
  }

  /** The full text of one item (other tools cut long texts). */
  getItem(args: { id: string }): Promise<{ item: Item | null }> {
    return this.lock.run(async () => ({ item: this.index.item(args.id, LIMITS.fullChars) ?? null }));
  }

  /** Brings the index up to date at startup without logging anything. */
  warmUp(): Promise<void> {
    return this.lock.run(() => this.syncLocked());
  }

  /** Waits (bounded) for background delivery, then closes the index. Undelivered commits stay queued in git. */
  async close(): Promise<void> {
    await this.lock.run(async () => {
      await Promise.race([this.transport.whenIdle(), new Promise((r) => setTimeout(r, LIMITS.closeWaitMs))]);
      this.index.close();
    });
  }

  // ---- internals ----------------------------------------------------------------

  private async syncLocked(): Promise<void> {
    const r = await syncIndex(this.index, this.transport);
    if (!r.sync.stale) this.lastSyncAt = this.now();
  }

  private async syncIfOld(): Promise<void> {
    if (this.now() - this.lastSyncAt > LIMITS.pullCacheMs) await this.syncLocked();
  }

  private takeNewFromOthers(limit: number): Digest {
    const at = this.cursor.position(this.index);
    const r = this.index.itemsAfter(at.seq, { excludeAuthor: this.me, limit, maxTextChars: LIMITS.itemChars, floor: at.floor });
    const newestTs = r.items.reduce((m, it) => Math.max(m, Date.parse(it.ts)), 0);
    if (r.lastSeq !== at.seq || r.items.length || at.floor) this.cursor.advance(this.index, at, r.lastSeq, newestTs);
    return { items: r.items.map(({ seq: _s, ...it }) => it), more: r.more };
  }

  private async report(): Promise<SyncReport> {
    // One call (one git spawn): the unpushed count changes after a write, so it's read fresh.
    const s = await this.transport.syncState();
    return {
      last_pull_at: s.lastPullAt,
      stale: s.stale,
      unpushed_commits: s.unpushed,
      last_error: s.lastError,
      search_mode: this.embedder ? "hybrid" : "keyword-only",
    };
  }
}

const ms = (x: number) => Math.round(x);
