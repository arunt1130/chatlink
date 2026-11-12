import { mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type Event, type StatusEvent, type StatusValue, type Tier, tierOf } from "../events/schema";
import { type EventStore, type IngestResult, canonicalJson } from "../events/store";
import { isInsideOrEqual } from "../events/paths";
import { type RankingConfig, RANKING, SEARCH_DEFAULTS, combineScore, recencyFactor } from "./ranking";

/**
 * Bump when the table layout or what gets indexed changes. A mismatch wipes
 * the index; the next sync rebuilds it from the logs (it is derived data).
 */
export const INDEX_SCHEMA_VERSION = 1;

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
`;

const DROP = `
DROP TRIGGER IF EXISTS events_ai; DROP TRIGGER IF EXISTS events_ad; DROP TRIGGER IF EXISTS events_au;
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

export type SearchHit = {
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
  score: number;
  /** The status in effect for this item, if anyone marked it. */
  status?: HitStatus;
};

export type OpenOptions = {
  /**
   * The shared repo this index is built from. The index file must live outside
   * it (derived files are never committed), and an index built from a
   * different repo is wiped on open.
   */
  source?: string;
};

type Row = { canon: string };
type HitRow = { canon: string; body: string | null; tier: string | null; score: number };

/** The text an event contributes to keyword search. */
function bodyOf(e: Event): string | null {
  if (e.kind === "status") return typeof e.reason === "string" ? e.reason : null;
  return typeof e.text === "string" ? e.text : null;
}

/** Turns free text into an FTS5 query: each word quoted, OR-ed. Never passes FTS syntax through. */
export function toFtsQuery(query: string, maxTerms: number = SEARCH_DEFAULTS.maxQueryTerms): string | null {
  const words = query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const uniq = [...new Set(words)].slice(0, maxTerms);
  return uniq.length ? uniq.map((w) => `"${w}"`).join(" OR ") : null;
}

/**
 * The local SQLite index (M2a: keyword search + recency). Also an EventStore,
 * with the same idempotent-by-id ingest and status resolution as MemoryStore.
 * Fully derived from the logs; delete it any time and rebuild.
 */
export class SqliteIndex implements EventStore {
  readonly file: string;
  private db: Database.Database;

  private constructor(file: string, db: Database.Database) {
    this.file = file;
    this.db = db;
  }

  static open(file: string, opts: OpenOptions = {}): SqliteIndex {
    const abs = file === ":memory:" ? file : assertIndexPath(file, opts.source);
    if (abs !== ":memory:") mkdirSync(path.dirname(abs), { recursive: true });
    let idx: SqliteIndex;
    try {
      idx = new SqliteIndex(abs, SqliteIndex.connect(abs));
    } catch (e) {
      // A corrupt or foreign file is just stale derived data: replace it.
      if (abs === ":memory:" || !isCorrupt(e)) throw e;
      deleteIndexFiles(abs);
      idx = new SqliteIndex(abs, SqliteIndex.connect(abs));
    }
    if (opts.source !== undefined) {
      const src = path.resolve(opts.source);
      const prev = idx.getMeta("source");
      if (prev !== null && prev !== src) idx.reset();
      idx.setMeta("source", src);
    }
    return idx;
  }

  private static connect(file: string): Database.Database {
    const db = new Database(file);
    try {
      db.pragma("journal_mode = WAL");
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
    this.db.transaction(() => {
      this.db.exec(DROP);
      this.db.exec(SCHEMA);
      if (source !== null) this.setMeta("source", source);
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
    return this.db.transaction(() => {
      const r = this.ingestRaw(events);
      this.setMeta("cursor", cursor);
      return r;
    })();
  }

  // ---- EventStore -----------------------------------------------------------

  ingest(events: Iterable<Event>): IngestResult {
    return this.db.transaction(() => this.ingestRaw(events))();
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
        continue;
      }
      insert.run(row);
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

  /** Keyword search ranked by bm25 × recency. Free text in; FTS syntax is never interpreted. */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const cfg: RankingConfig = { ...RANKING, ...opts.ranking };
    const now = opts.now ?? Date.now();
    const limit = clampLimit(opts.limit);
    const maxChars = Math.max(1, opts.maxTextChars ?? SEARCH_DEFAULTS.maxTextChars);

    const where: string[] = ["events_fts MATCH @fts"];
    const params: Record<string, unknown> = { fts, now, limit };
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

    // Registered per call so the weights in force are exactly this call's.
    this.db.function("chatlink_score", { deterministic: true }, (kw: unknown, tsMs: unknown, nowMs: unknown) =>
      combineScore(Number(kw), recencyFactor(Number(nowMs) - Number(tsMs), cfg)),
    );
    const rows = this.db
      .prepare(
        `SELECT e.canon AS canon, e.body AS body, e.tier AS tier,
                chatlink_score(-bm25(events_fts), e.ts_ms, @now) AS score
           FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
          WHERE ${where.join(" AND ")}
          ORDER BY score DESC, e.ts_ms DESC, e.id DESC
          LIMIT @limit`,
      )
      .all(params) as HitRow[];

    return rows.map((r) => {
      const e = JSON.parse(r.canon) as Event;
      const full = r.body ?? "";
      const hit: SearchHit = {
        id: e.id,
        author: e.author,
        ts: e.ts,
        kind: e.kind,
        tier: (r.tier as Tier | null) ?? null,
        text: full.length > maxChars ? cutText(full, maxChars) : full,
        truncated: full.length > maxChars,
        textLength: full.length,
        score: r.score,
      };
      const s = this.resolveStatus(e.id);
      if (s) hit.status = { id: s.id, author: s.author, ts: s.ts, status: s.status, reason: s.reason };
      return hit;
    });
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
  return code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB";
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
