import { type Event, type StatusEvent, compareEvents } from "./schema";

export type IngestResult = { added: number; duplicates: number; conflicts: number };

/** Where ingested events live. MemoryStore now; a SQLite store joins in M2a. */
export interface EventStore {
  /** Idempotent by id: an id already present is never added again. */
  ingest(events: Iterable<Event>): IngestResult;
  has(id: string): boolean;
  get(id: string): Event | undefined;
  /** All events in (ts, id) order. */
  all(): Event[];
  readonly size: number;
  /** The status in effect for `target`: latest by ts, ties broken by id. */
  resolveStatus(target: string): StatusEvent | undefined;
}

/** JSON with object keys sorted, so equal events compare equal regardless of key order. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

export class MemoryStore implements EventStore {
  private byId = new Map<string, { event: Event; canon: string }>();
  private statusByTarget = new Map<string, StatusEvent>();

  ingest(events: Iterable<Event>): IngestResult {
    const r: IngestResult = { added: 0, duplicates: 0, conflicts: 0 };
    for (const e of events) {
      const canon = canonicalJson(e);
      const prev = this.byId.get(e.id);
      if (prev) {
        if (prev.canon === canon) {
          r.duplicates++;
          continue;
        }
        // Two different events claim one id (should never happen with ULIDs).
        // Keep the canonically smaller one so the result doesn't depend on
        // ingest order.
        r.conflicts++;
        if (prev.canon <= canon) continue;
        this.byId.set(e.id, { event: e, canon });
        this.rebuildStatus();
        continue;
      }
      this.byId.set(e.id, { event: e, canon });
      r.added++;
      if (e.kind === "status") this.considerStatus(e as StatusEvent);
    }
    return r;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Event | undefined {
    return this.byId.get(id)?.event;
  }

  all(): Event[] {
    return [...this.byId.values()].map((x) => x.event).sort(compareEvents);
  }

  get size(): number {
    return this.byId.size;
  }

  resolveStatus(target: string): StatusEvent | undefined {
    return this.statusByTarget.get(target);
  }

  private considerStatus(s: StatusEvent): void {
    const cur = this.statusByTarget.get(s.target);
    if (!cur || compareEvents(s, cur) > 0) this.statusByTarget.set(s.target, s);
  }

  private rebuildStatus(): void {
    this.statusByTarget.clear();
    for (const { event } of this.byId.values()) if (event.kind === "status") this.considerStatus(event as StatusEvent);
  }
}
