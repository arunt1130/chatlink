import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { Db } from "./db";
import { type Event, type StatusEvent, type StatusValue, type Tier, tierOf } from "../events/schema";
import { type EventStore, type IngestResult, canonicalJson } from "../events/store";
import { isInsideOrEqual } from "../events/paths";
import { type Embedder, dot } from "../embed/types";
import { type RankingConfig, SEARCH_DEFAULTS, rankingWith, scoreOf } from "./ranking";
import { queryTerms } from "./query";

/**
 * Bump when the table layout or what gets indexed changes. A mismatch wipes
 * the index; the next sync rebuilds it from the logs (it is derived data).
 */
export const INDEX_SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE events (
  rowid  INTEGER PRIMARY KEY,
  id     TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  ts     TEXT NOT NULL,
  ts_ms  INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  tier   TEXT,
  target TEXT,
  body   TEXT,
  canon  TEXT NOT NULL
);
CREATE INDEX events_order ON events (ts_ms, id);
CREATE INDEX events_author ON events (author, ts_ms);
CREATE INDEX events_status ON events (target, ts_ms, id) WHERE kind = 'status';
CREATE VIRTUAL TABLE events_fts USING fts5 (
  body, content = 'events', content_rowid = 'rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts (events_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts (events_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO events_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- One embedding per event with text (float32 little-endian), for the embedder named in meta.embedder.
CREATE TABLE vectors (rowid INTEGER PRIMARY KEY, vec BLOB NOT NULL);
CREATE TRIGGER events_ad_vec AFTER DELETE ON events BEGIN DELETE FROM vectors WHERE rowid = old.rowid; END;
`;

const DROP = `
DROP TRIGGER IF EXISTS events_ai; DROP TRIGGER IF EXISTS events_ad; DROP TRIGGER IF EXISTS events_au;
DROP TRIGGER IF EXISTS events_ad_vec; DROP TABLE IF EXISTS vectors;
DROP TABLE IF EXISTS events_fts; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS meta;
`;

export type SearchOptions = {
  author?: string;
  /** Only items at or after this UTC ISO time. */
  since?: string;
  limit?: number;
  /** Reference time for recency (ms). Defaults to now; tests pin it. */
  now?: number;
  ranking?: Partial<RankingConfig>;
  maxTextChars?: number;
};

export type HitStatus = { id: string; author: string; ts: string; status: StatusValue; reason: string };

/** How every tool shows an event: who, when, what kind, how trusted, and the verbatim text. */
export type Item = {
  id: string;
  author: string;
  ts: string;
  kind: string;
  tier: Tier | null;
  /** Verbatim text (a status event's reason), cut to maxTextChars if longer. */
  text: string;
  truncated: boolean;
  /** Length of the full text, so a caller knows how much was cut. */
  textLength: number;
  /** For a status event: what it marks, and how. */
  target?: string;
  marks?: StatusValue;
  /** For an assistant_note: the event it is about. */
  about?: string;
  /** The status in effect for this item, if anyone marked it. */
  status?: HitStatus;
};

export type SearchHit = Item & {
  score: number;
  /** Why it matched: normalized keyword score and vector similarity, each in [0, 1]. */
  match: { keyword: number; vector: number };
};

export type OpenOptions = {
  /**
   * The shared repo this index is built from. The index file must live outside
   * it (derived files are never committed), and an index built from a
   * different repo is wiped on open.
   */
  source?: string;
  /**
   * Enables vector search. Every event with text gets an embedding at ingest.
   * Opening with a different embedder (by id) re-embeds everything; events
   * missing a vector are embedded on open. Without one, search is keyword-only.
   */
  embedder?: Embedder;
};

type Row = { canon: string };
type VecEntry = { ts_ms: number; id: string; author: string; vec: Float32Array };
type Cand = { rowid: number; ts_ms: number; id: string; keyword: number; vector: number };

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** The text an event contributes to keyword search. */
function bodyOf(e: Event): string | null {
  if (e.kind === "status") return typeof e.reason === "string" ? e.reason : null;
  return typeof e.text === "string" ? e.text : null;
}


/**
 * The local SQLite index: keyword (FTS5) + vector search, hybrid-ranked. Also an EventStore,
 * with the same idempotent-by-id ingest and status resolution as MemoryStore.
 * Fully derived from the logs; delete it any time and rebuild.
 */
export class SqliteIndex implements EventStore {
  readonly file: string;
  private db: Db;

  readonly embedder: Embedder | undefined;
  /**
   * All vectors, held in memory after the first vector search so a query is a
   * pure-JS scan (copying blobs out of WebAssembly per query is slow). Kept in
   * step on ingest; dropped (reloaded lazily) on bulk changes or a failed write.
   */
  private vecCache: Map<number, VecEntry> | null = null;

  private constructor(file: string, db: Db, embedder: Embedder | undefined) {
    this.file = file;
    this.db = db;
    this.embedder = embedder;
  }

  static open(file: string, opts: OpenOptions = {}): SqliteIndex {
    const abs = file === ":memory:" ? file : assertIndexPath(file, opts.source);
    if (abs !== ":memory:") mkdirSync(path.dirname(abs), { recursive: true });
    let idx: SqliteIndex;
    try {
      idx = new SqliteIndex(abs, SqliteIndex.connect(abs), opts.embedder);
    } catch (e) {
      // A corrupt or foreign file is just stale derived data: replace it.
      if (abs === ":memory:" || !isCorrupt(e)) throw e;
      deleteIndexFiles(abs);
      idx = new SqliteIndex(abs, SqliteIndex.connect(abs), opts.embedder);
    }
    try {
      if (opts.source !== undefined) {
        const src = path.resolve(opts.source);
        const prev = idx.getMeta("source");
        if (prev !== null && prev !== src) idx.reset();
        idx.setMeta("source", src);
      }
      idx.syncEmbeddings();
    } catch (e) {
      idx.close();
      throw e;
    }
    return idx;
  }

  /**
   * Makes the stored vectors match this index's embedder: a different model
   * drops them all; then every event with text but no vector is embedded.
   * Returns how many were embedded. A no-op without an embedder.
   */
  syncEmbeddings(): number {
    const em = this.embedder;
    if (!em) return 0;
    return this.db.transaction(() => {
      if (this.getMeta("embedder") !== em.id) {
        this.db.exec("DELETE FROM vectors");
        this.setMeta("embedder", em.id);
      }
      const missing = this.db
        .prepare("SELECT e.rowid AS rowid, e.body AS body FROM events e LEFT JOIN vectors v ON v.rowid = e.rowid WHERE v.rowid IS NULL AND e.body IS NOT NULL")
        .all() as { rowid: number; body: string }[];
      const put = this.db.prepare("INSERT OR REPLACE INTO vectors (rowid, vec) VALUES (?, ?)");
      for (const m of missing) put.run(m.rowid, toBlob(em.embed(m.body)));
      this.vecCache = null;
      return missing.length;
    })();
  }

  private static connect(file: string): Db {
    const db = new Db(file);
    try {
      db.pragma("synchronous = NORMAL"); // derived data: speed over durability
      const v = db.pragma("user_version", { simple: true }) as number;
      if (v !== INDEX_SCHEMA_VERSION) {
        db.exec("BEGIN");
        db.exec(DROP);
        db.exec(SCHEMA);
        db.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`);
        db.exec("COMMIT");
      }
      db.prepare("SELECT count(*) FROM events").get(); // touches the file; surfaces corruption now
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  /** Empties the index (keeps the file). The next sync re-reads everything. */
  reset(): void {
    const source = this.getMeta("source");
    this.vecCache = null;
    this.db.transaction(() => {
      this.db.exec(DROP);
      this.db.exec(SCHEMA);
      if (source !== null) this.setMeta("source", source);
      if (this.embedder) this.setMeta("embedder", this.embedder.id);
    })();
  }

  // ---- meta / cursor --------------------------------------------------------

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The transport cursor the index has caught up to, or undefined (read everything). */
  get cursor(): string | undefined {
    return this.getMeta("cursor") ?? undefined;
  }

  /** Ingests and advances the cursor in one transaction, so a crash can't leave them out of step. */
  ingestAt(events: Iterable<Event>, cursor: string): IngestResult {
    return this.guarded(() =>
      this.db.transaction(() => {
        const r = this.ingestRaw(events);
        this.setMeta("cursor", cursor);
        return r;
      })(),
    );
  }

  /** A failed (rolled back) write may have touched the in-memory vectors: drop them. */
  private guarded<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      this.vecCache = null;
      throw e;
    }
  }

  // ---- EventStore -----------------------------------------------------------

  ingest(events: Iterable<Event>): IngestResult {
    return this.guarded(() => this.db.transaction(() => this.ingestRaw(events))());
  }

  private ingestRaw(events: Iterable<Event>): IngestResult {
    const r: IngestResult = { added: 0, duplicates: 0, conflicts: 0 };
    const find = this.db.prepare("SELECT canon FROM events WHERE id = ?");
    const insert = this.db.prepare(
      "INSERT INTO events (id, author, ts, ts_ms, kind, tier, target, body, canon) VALUES (@id, @author, @ts, @ts_ms, @kind, @tier, @target, @body, @canon)",
    );
    const update = this.db.prepare(
      "UPDATE events SET author = @author, ts = @ts, ts_ms = @ts_ms, kind = @kind, tier = @tier, target = @target, body = @body, canon = @canon WHERE id = @id",
    );
    const rowidOf = this.db.prepare("SELECT rowid FROM events WHERE id = ?").pluck();
    const putVec = this.db.prepare("INSERT OR REPLACE INTO vectors (rowid, vec) VALUES (?, ?)");
    const dropVec = this.db.prepare("DELETE FROM vectors WHERE rowid = ?");
    const em = this.embedder;
    const embedRow = (row: { id: string; author: string; ts_ms: number; body: string | null }) => {
      if (!em) return;
      const rowid = rowidOf.get(row.id) as number;
      if (row.body === null) {
        dropVec.run(rowid);
        this.vecCache?.delete(rowid);
      } else {
        const vec = em.embed(row.body);
        putVec.run(rowid, toBlob(vec));
        this.vecCache?.set(rowid, { ts_ms: row.ts_ms, id: row.id, author: row.author, vec });
      }
    };
    for (const e of events) {
      const canon = canonicalJson(e);
      const prev = find.get(e.id) as Row | undefined;
      const row = {
        id: e.id,
        author: e.author,
        ts: e.ts,
        ts_ms: Date.parse(e.ts),
        kind: e.kind,
        tier: tierOf(e),
        target: e.kind === "status" && typeof e.target === "string" ? e.target : null,
        body: bodyOf(e),
        canon,
      };
      if (prev) {
        if (prev.canon === canon) {
          r.duplicates++;
          continue;
        }
        // Same rule as MemoryStore: keep the canonically smaller event, so the
        // result doesn't depend on ingest order.
        r.conflicts++;
        if (prev.canon <= canon) continue;
        update.run(row);
        embedRow(row);
        continue;
      }
      insert.run(row);
      embedRow(row);
      r.added++;
    }
    return r;
  }

  has(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE id = ?").get(id) !== undefined;
  }

  get(id: string): Event | undefined {
    const r = this.db.prepare("SELECT canon FROM events WHERE id = ?").get(id) as Row | undefined;
    return r ? (JSON.parse(r.canon) as Event) : undefined;
  }

  all(): Event[] {
    const rows = this.db.prepare("SELECT canon FROM events ORDER BY ts_ms, id").all() as Row[];
    return rows.map((r) => JSON.parse(r.canon) as Event);
  }

  get size(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
  }

  /** Latest status by ts (as an instant), ties broken by id. */
  resolveStatus(target: string): StatusEvent | undefined {
    const r = this.db
      .prepare("SELECT canon FROM events WHERE kind = 'status' AND target = ? ORDER BY ts_ms DESC, id DESC LIMIT 1")
      .get(target) as Row | undefined;
    return r ? (JSON.parse(r.canon) as StatusEvent) : undefined;
  }

  // ---- search ---------------------------------------------------------------

  /** All vectors with what the filters need, loaded once (see vecCache). */
  private vectors(): Map<number, VecEntry> {
    if (!this.vecCache) {
      const rows = this.db
        .prepare("SELECT e.rowid AS rowid, e.ts_ms AS ts_ms, e.id AS id, e.author AS author, v.vec AS vec FROM vectors v JOIN events e ON e.rowid = v.rowid")
        .all() as { rowid: number; ts_ms: number; id: string; author: string; vec: Uint8Array }[];
      this.vecCache = new Map(rows.map((r) => [r.rowid, { ts_ms: r.ts_ms, id: r.id, author: r.author, vec: fromBlob(r.vec) }]));
    }
    return this.vecCache;
  }

  /**
   * For each of `rowids`: the idf-weighted share of `terms` it contains, in
   * [0, 1]. A term no document contains still counts in the denominator (it
   * is part of what was asked). idf = ln(1 + (N − df + 0.5) / (df + 0.5)).
   */
  private termCoverage(terms: string[], rowids: Set<number>): Map<number, number> {
    const n = (this.db.prepare("SELECT count(*) AS n FROM events WHERE body IS NOT NULL").get() as { n: number }).n;
    const match = this.db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").pluck();
    const got = new Map<number, number>();
    let total = 0;
    for (const t of terms) {
      const hits = match.all(`"${t}"`) as number[];
      const idf = Math.log(1 + (n - hits.length + 0.5) / (hits.length + 0.5));
      total += idf;
      for (const r of hits) if (rowids.has(r)) got.set(r, (got.get(r) ?? 0) + idf);
    }
    for (const [r, v] of got) got.set(r, total > 0 ? v / total : 0);
    return got;
  }

  /**
   * Hybrid search: keyword (bm25) and vector (cosine) candidates, merged and
   * ranked by `scoreOf` (see ranking.ts). Free text in; FTS syntax is never
   * interpreted. Keyword-only when the index has no embedder.
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const fts = terms.map((w) => `"${w}"`).join(" OR ");
    const cfg: RankingConfig = rankingWith(opts.ranking);
    const now = opts.now ?? Date.now();
    const limit = clampLimit(opts.limit);
    const pool = Math.max(limit, Math.floor(cfg.candidatePool));
    const maxChars = Math.max(1, opts.maxTextChars ?? SEARCH_DEFAULTS.maxTextChars);

    const where: string[] = [];
    const params: Record<string, unknown> = { fts, pool };
    if (opts.author !== undefined) {
      where.push("e.author = @author");
      params.author = opts.author;
    }
    if (opts.since !== undefined) {
      // ISO 8601 with an explicit zone only; "2026-11-12T10:00" would silently mean local time.
      const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(opts.since);
      const ms = iso ? Date.parse(opts.since.length === 10 ? `${opts.since}T00:00:00Z` : opts.since) : NaN;
      if (Number.isNaN(ms)) throw new RangeError(`invalid since: ${JSON.stringify(opts.since)}`);
      where.push("e.ts_ms >= @since");
      params.since = ms;
    }

    const filter = where.length ? ` AND ${where.join(" AND ")}` : "";
    const cands = new Map<number, Cand>();

    // Keyword candidates: best bm25 first. Their score is absolute, not relative
    // to the best hit: idf-weighted share of query terms matched, scaled by bm25.
    const kw = this.db
      .prepare(
        `SELECT e.rowid AS rowid, e.ts_ms AS ts_ms, e.id AS id, -bm25(events_fts) AS kw
           FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
          WHERE events_fts MATCH @fts${filter}
          ORDER BY bm25(events_fts), e.ts_ms DESC, e.id DESC
          LIMIT @pool`,
      )
      .all(params) as { rowid: number; ts_ms: number; id: string; kw: number }[];
    const best = kw.reduce((m, r) => Math.max(m, r.kw), 0);
    const coverage = kw.length ? this.termCoverage(terms, new Set(kw.map((r) => r.rowid))) : new Map<number, number>();
    for (const r of kw) {
      const keyword = (coverage.get(r.rowid) ?? 0) * (0.5 + 0.5 * (best > 0 ? r.kw / best : 0));
      cands.set(r.rowid, { rowid: r.rowid, ts_ms: r.ts_ms, id: r.id, keyword, vector: 0 });
    }

    // Vector candidates: exact scan (see DECISIONS.md), above minVectorSim.
    const em = this.embedder;
    const qv = em ? em.embed(query) : null;
    if (em && qv && qv.some((x) => x !== 0)) {
      const authorF = params.author as string | undefined;
      const sinceF = params.since as number | undefined;
      const sims: { r: { rowid: number; ts_ms: number; id: string }; sim: number }[] = [];
      for (const [rowid, v] of this.vectors()) {
        if (authorF !== undefined && v.author !== authorF) continue;
        if (sinceF !== undefined && v.ts_ms < sinceF) continue;
        if (v.vec.length !== qv.length) continue;
        const sim = Math.min(1, dot(qv, v.vec));
        if (sim >= cfg.minVectorSim) sims.push({ r: { rowid, ts_ms: v.ts_ms, id: v.id }, sim });
      }
      sims.sort((a, b) => b.sim - a.sim || b.r.ts_ms - a.r.ts_ms || (a.r.id < b.r.id ? 1 : -1));
      for (const { r, sim } of sims.slice(0, pool)) {
        const c = cands.get(r.rowid);
        if (c) c.vector = sim;
        else cands.set(r.rowid, { rowid: r.rowid, ts_ms: r.ts_ms, id: r.id, keyword: 0, vector: sim });
      }
    }

    const getRow = this.db.prepare("SELECT canon, body, tier FROM events WHERE rowid = ?");
    const scored = [...cands.values()].map((c) => {
      const row = getRow.get(c.rowid) as { canon: string; body: string | null; tier: Tier | null };
      const s = this.resolveStatus(c.id);
      const score = scoreOf({ keyword: c.keyword, vector: c.vector, ageMs: now - c.ts_ms, tier: row.tier, status: s?.status ?? null }, cfg);
      return { c, row, s, score };
    });
    scored.sort((a, b) => b.score - a.score || b.c.ts_ms - a.c.ts_ms || (a.c.id < b.c.id ? 1 : a.c.id > b.c.id ? -1 : 0));

    return scored.slice(0, limit).map(({ c, row, s, score }) => ({
      ...this.toItem(JSON.parse(row.canon) as Event, maxChars, s ?? null),
      score,
      match: { keyword: c.keyword, vector: c.vector },
    }));
  }

  // ---- items and ingest order -------------------------------------------------

  /** One event as an Item (with its current status), or undefined if unknown. */
  item(id: string, maxTextChars: number = SEARCH_DEFAULTS.maxTextChars): Item | undefined {
    const e = this.get(id);
    return e ? this.toItem(e, maxTextChars) : undefined;
  }

  /** `status`: the already-resolved status (null = none); omitted = look it up. */
  private toItem(e: Event, maxChars: number, known?: StatusEvent | null): Item {
    const status = known === undefined ? this.resolveStatus(e.id) : (known ?? undefined);
    const full = bodyOf(e) ?? "";
    const it: Item = {
      id: e.id,
      author: e.author,
      ts: e.ts,
      kind: e.kind,
      tier: tierOf(e),
      text: full.length > maxChars ? cutText(full, maxChars) : full,
      truncated: full.length > maxChars,
      textLength: full.length,
    };
    if (e.kind === "status") {
      if (typeof e.target === "string") it.target = e.target;
      if (typeof e.status === "string") it.marks = e.status as StatusValue;
    }
    if (e.kind === "assistant_note" && typeof e.about === "string") it.about = e.about;
    if (status) it.status = { id: status.id, author: status.author, ts: status.ts, status: status.status, reason: status.reason };
    return it;
  }

  /**
   * Identifies this index's ingest order. It changes whenever the index is
   * created or reset, so a stored sequence number is only valid with its epoch.
   */
  get epoch(): string {
    let e = this.getMeta("epoch");
    if (e === null) {
      e = randomBytes(8).toString("hex");
      this.setMeta("epoch", e);
    }
    return e;
  }

  /** The highest ingest sequence number so far (0 when empty). */
  get maxSeq(): number {
    return (this.db.prepare("SELECT coalesce(max(rowid), 0) AS n FROM events").get() as { n: number }).n;
  }

  /**
   * Events ingested after `seq`, in ingest order (so a late-arriving event with
   * an old ts still shows up), optionally excluding one author. At most `limit`.
   *
   * `floor` re-anchors a cursor after a rebuild, whose ingest order is by
   * author folder rather than by time: rows up to `upToSeq` count only if their
   * ts is after `afterTsMs`; rows ingested later always count.
   */
  itemsAfter(
    seq: number,
    opts: { excludeAuthor?: string; limit?: number; maxTextChars?: number; floor?: { upToSeq: number; afterTsMs: number } } = {},
  ): { items: (Item & { seq: number })[]; more: boolean; lastSeq: number } {
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const where = ["rowid > @seq"];
    const params: Record<string, unknown> = { seq, limit: limit + 1 };
    if (opts.excludeAuthor !== undefined) {
      where.push("author != @me");
      params.me = opts.excludeAuthor;
    }
    if (opts.floor) {
      where.push("(rowid > @upTo OR ts_ms > @afterTs)");
      params.upTo = opts.floor.upToSeq;
      params.afterTs = opts.floor.afterTsMs;
    }
    const rows = this.db
      .prepare(`SELECT rowid, canon FROM events WHERE ${where.join(" AND ")} ORDER BY rowid LIMIT @limit`)
      .all(params) as { rowid: number; canon: string }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const maxChars = Math.max(1, opts.maxTextChars ?? SEARCH_DEFAULTS.maxTextChars);
    const items = page.map((r) => ({ ...this.toItem(JSON.parse(r.canon) as Event, maxChars), seq: r.rowid }));
    // With nothing (more) to show, the cursor may jump to the end, past my own events.
    const lastSeq = more ? page[page.length - 1]!.rowid : this.maxSeq;
    return { items, more, lastSeq: Math.max(seq, lastSeq) };
  }
}

/** First `n` UTF-16 units, backing off one so a surrogate pair is never split. */
function cutText(s: string, n: number): string {
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return SEARCH_DEFAULTS.limit;
  return Math.min(SEARCH_DEFAULTS.maxLimit, Math.max(1, Math.floor(n)));
}

function isCorrupt(e: unknown): boolean {
  const code = (e as { code?: string }).code ?? "";
  const msg = (e as { message?: string }).message ?? "";
  return code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB" || /not a database|malformed|corrupt/i.test(msg);
}

/** Extensions an index file may have. None of them can be a shared log (`.jsonl`) or `space.json`. */
export const INDEX_FILE_RE = /\.(sqlite|sqlite3|db)$/i;

/**
 * Checks an index path before anything opens or deletes it: it must end in
 * .sqlite/.sqlite3/.db (so it can never be a log file, whatever the caller
 * passes) and lie outside the shared repo, after resolving symlinks where the
 * path exists. Returns the absolute path.
 */
export function assertIndexPath(file: string, source?: string): string {
  const abs = path.resolve(file);
  if (!INDEX_FILE_RE.test(abs)) throw new Error(`index file must end in .sqlite, .sqlite3 or .db: ${abs}`);
  if (source !== undefined) {
    const real = (p: string) => {
      // Resolve the deepest existing ancestor, so a symlinked/junctioned state dir is caught.
      let cur = p;
      const rest: string[] = [];
      for (;;) {
        try {
          return path.join(realpathSync.native(cur), ...rest.reverse());
        } catch {
          const parent = path.dirname(cur);
          if (parent === cur) return p;
          rest.push(path.basename(cur));
          cur = parent;
        }
      }
    };
    const src = path.resolve(source);
    if (isInsideOrEqual(abs, src) || isInsideOrEqual(real(abs), real(src))) {
      throw new Error(`index file must be outside the shared repo: ${abs}`);
    }
  }
  return abs;
}

/** Removes the index file and its WAL/SHM siblings. Refuses any path that isn't an index file. */
export function deleteIndexFiles(file: string): void {
  if (!INDEX_FILE_RE.test(file)) throw new Error(`refusing to delete a non-index file: ${file}`);
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    rmSync(f, { force: true, maxRetries: 5, retryDelay: 100 });
  }
}
