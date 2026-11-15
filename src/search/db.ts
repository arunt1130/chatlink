import { Database as WasmDatabase } from "node-sqlite3-wasm";

/**
 * The one place that touches the SQLite driver. node-sqlite3-wasm is SQLite
 * compiled to WebAssembly (FTS5 included), so the bundle carries no native
 * binary and runs on any OS and any Node runtime, including the one inside
 * Claude Desktop. See DECISIONS.md.
 *
 * This mirrors the small slice of the better-sqlite3 API the index uses
 * (prepare/get/all/run/pluck, exec, pragma, transaction), so the index code
 * reads the same. Statements are prepared and finalized per call (the driver
 * leaks memory for statements that are never finalized).
 */
type Params = unknown[];
type Bindable = unknown[] | Record<string, unknown> | undefined;

/** better-sqlite3 style: f(a, b) positional, or f({ x }) for @x named parameters. */
function bind(args: Params): Bindable {
  if (args.length === 0) return undefined;
  if (args.length === 1) {
    const a = args[0];
    if (a !== null && typeof a === "object" && !Array.isArray(a) && !(a instanceof Uint8Array)) {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) o[/^[@:$]/.test(k) ? k : `@${k}`] = norm(v);
      return o;
    }
  }
  return args.map(norm);
}

const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

export type Statement = {
  get(...args: Params): unknown;
  all(...args: Params): unknown[];
  run(...args: Params): { changes: number; lastInsertRowid: number | bigint };
  /** Return only the first column of each row. */
  pluck(): Statement;
};

export class Db {
  private readonly db: WasmDatabase;
  private depth = 0;

  constructor(file: string) {
    this.db = new WasmDatabase(file);
  }

  get open(): boolean {
    return this.db.isOpen;
  }

  exec(sql: string): void {
    // DROP/CREATE invalidates prepared statements on dropped tables: start fresh.
    if (/\b(DROP|CREATE)\b/i.test(sql)) {
      for (const s of this.cache.values()) if (!s.isFinalized) s.finalize();
      this.cache.clear();
    }
    this.db.exec(sql);
  }

  /**
   * Statements are prepared once per SQL text and reused (preparing costs far
   * more under WebAssembly than running). All are finalized on close.
   */
  private readonly cache = new Map<string, ReturnType<WasmDatabase["prepare"]>>();

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size >= 256) {
        const [k, old] = this.cache.entries().next().value!;
        old.finalize();
        this.cache.delete(k);
      }
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  prepare(sql: string): Statement {
    const make = (pluck: boolean): Statement => {
      const first = (row: unknown) => (row && typeof row === "object" ? Object.values(row as object)[0] : row);
      // The driver only resets a statement when it is next bound, so a get()
      // that stopped after one row would keep a read open (and the file
      // locked). Reset right after every use.
      const use = <T>(fn: (s: ReturnType<WasmDatabase["prepare"]>) => T): T => {
        const s = this.stmt(sql);
        try {
          return fn(s);
        } finally {
          (s as unknown as { _reset?: () => boolean })._reset?.();
        }
      };
      return {
        get: (...a) => {
          const r = use((s) => s.get(bind(a) as never)) ?? undefined;
          return pluck ? (r === undefined ? undefined : first(r)) : r;
        },
        all: (...a) => {
          const rows = use((s) => s.all(bind(a) as never)) as unknown[];
          return pluck ? rows.map(first) : rows;
        },
        run: (...a) => use((s) => s.run(bind(a) as never)) as { changes: number; lastInsertRowid: number | bigint },
        pluck: () => make(true),
      };
    };
    return make(false);
  }

  /** `pragma("user_version", { simple: true })` reads one value; `pragma("x = 1")` sets. */
  pragma(p: string, opts: { simple?: boolean } = {}): unknown {
    if (p.includes("=")) {
      this.db.exec(`PRAGMA ${p}`);
      return undefined;
    }
    const row = this.db.get(`PRAGMA ${p}`) as Record<string, unknown> | null;
    if (!opts.simple) return row;
    return row ? Object.values(row)[0] : undefined;
  }

  /** better-sqlite3 style: returns a function that runs `fn` in a transaction (nested calls join the outer one). */
  transaction<A extends unknown[], T>(fn: (...a: A) => T): (...a: A) => T {
    return (...a: A) => {
      if (this.depth > 0) return fn(...a);
      this.db.exec("BEGIN");
      this.depth++;
      try {
        const r = fn(...a);
        this.db.exec("COMMIT");
        return r;
      } catch (e) {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw e;
      } finally {
        this.depth--;
      }
    };
  }

  close(): void {
    for (const s of this.cache.values()) if (!s.isFinalized) s.finalize();
    this.cache.clear();
    if (this.db.isOpen) this.db.close();
  }
}
