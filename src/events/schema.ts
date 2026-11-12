import { ULID_RE, ulid as defaultUlid } from "./ulid";

export const SCHEMA_VERSION = 1;

/** Lowercase slug; also the author's folder name under logs/. */
export const AUTHOR_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** UUIDv7, lowercase only, so one id has exactly one spelling. */
export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** UTC ISO 8601 with optional milliseconds (what toISOString() emits). */
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export const STATUS_VALUES = ["decided", "closed", "reopened", "superseded"] as const;
export type StatusValue = (typeof STATUS_VALUES)[number];
export const IMPORT_ROLES = ["human", "assistant"] as const;
export type ImportRole = (typeof IMPORT_ROLES)[number];

export type Base = { v: number; id: string; author: string; ts: string; [extra: string]: unknown };

export type MessageEvent = Base & { kind: "message"; text: string };
export type StatusEvent = Base & { kind: "status"; target: string; status: StatusValue; reason: string };
export type NoteEvent = Base & { kind: "note"; text: string };
export type AssistantNoteEvent = Base & { kind: "assistant_note"; text: string; about: string };
export type ImportEvent = Base & { kind: "import"; text: string; role: ImportRole; original_ts?: string };
export type KnownEvent = MessageEvent | StatusEvent | NoteEvent | AssistantNoteEvent | ImportEvent;
export type KnownKind = KnownEvent["kind"];
/** An event of a kind this version does not know. Kept for forward compatibility. */
export type UnknownEvent = Base & { kind: string };
export type Event = KnownEvent | UnknownEvent;

export const KNOWN_KINDS: readonly KnownKind[] = ["message", "status", "note", "assistant_note", "import"];

export type Tier = "confirmed" | "said" | "imported" | "model-written";

export function isEventId(s: unknown): s is string {
  return typeof s === "string" && (ULID_RE.test(s) || UUIDV7_RE.test(s));
}

export function isAuthor(s: unknown): s is string {
  return typeof s === "string" && AUTHOR_RE.test(s);
}

export function isUtcTs(s: unknown): s is string {
  if (typeof s !== "string" || !TS_RE.test(s)) return false;
  const ms = Date.parse(s);
  // Round-trip check rejects dates that parse but roll over (Feb 30, 24:00).
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
}

export function isKnownKind(k: string): k is KnownKind {
  return (KNOWN_KINDS as readonly string[]).includes(k);
}

export type Validation = { ok: true; event: Event } | { ok: false; reason: string };

const isStr = (x: unknown): x is string => typeof x === "string";

/** Checks an already-parsed JSON value. Never throws. */
export function validateEvent(x: unknown): Validation {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return { ok: false, reason: "not an object" };
  const o = x as Record<string, unknown>;
  if (typeof o.v !== "number" || !Number.isInteger(o.v) || o.v < 1) return { ok: false, reason: "bad or missing v" };
  if (!isEventId(o.id)) return { ok: false, reason: "bad or missing id" };
  if (!isAuthor(o.author)) return { ok: false, reason: "bad or missing author" };
  if (!isUtcTs(o.ts)) return { ok: false, reason: "bad or missing ts" };
  if (!isStr(o.kind) || o.kind.length === 0) return { ok: false, reason: "bad or missing kind" };

  // Field rules for known kinds apply to the schema version we know. Newer
  // versions are kept on their base fields alone (forward compatible).
  if (o.v === SCHEMA_VERSION && isKnownKind(o.kind)) {
    const bad = (f: string) => ({ ok: false as const, reason: `${o.kind}: bad or missing ${f}` });
    switch (o.kind) {
      case "message":
      case "note":
        if (!isStr(o.text)) return bad("text");
        break;
      case "status":
        if (!isEventId(o.target)) return bad("target");
        if (!(STATUS_VALUES as readonly unknown[]).includes(o.status)) return bad("status");
        if (!isStr(o.reason)) return bad("reason");
        break;
      case "assistant_note":
        if (!isStr(o.text)) return bad("text");
        if (!isEventId(o.about)) return bad("about");
        break;
      case "import":
        if (!isStr(o.text)) return bad("text");
        if (!(IMPORT_ROLES as readonly unknown[]).includes(o.role)) return bad("role");
        if (o.original_ts !== undefined && !isUtcTs(o.original_ts)) return bad("original_ts");
        break;
    }
  }
  return { ok: true, event: o as Event };
}

/** Kind-specific fields a caller supplies; makeEvent fills in v, id, author, ts. */
export type EventFields =
  | { kind: "message"; text: string }
  | { kind: "status"; target: string; status: StatusValue; reason: string }
  | { kind: "note"; text: string }
  | { kind: "assistant_note"; text: string; about: string }
  | { kind: "import"; text: string; role: ImportRole; original_ts?: string };

export function makeEvent<F extends EventFields>(
  author: string,
  fields: F,
  opts: { now?: number; id?: string } = {},
): Base & F {
  const now = opts.now ?? Date.now();
  const ev = { v: SCHEMA_VERSION, id: opts.id ?? defaultUlid(now), author, ts: new Date(now).toISOString(), ...fields };
  const r = validateEvent(ev);
  if (!r.ok) throw new Error(`invalid event: ${r.reason}`);
  return ev as Base & F;
}

export function tierOf(e: Event): Tier | null {
  switch (e.kind) {
    case "status":
    case "note":
      return "confirmed";
    case "message":
      return "said";
    case "import":
      return "imported";
    case "assistant_note":
      return "model-written";
    default:
      return null;
  }
}

/** Total order on events: ts (as an instant), then id. */
export function compareEvents(a: Base, b: Base): number {
  const d = Date.parse(a.ts) - Date.parse(b.ts);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** UTC day (YYYY-MM-DD) an event belongs to, taken from its own ts. */
export function dayOf(ts: string): string {
  return ts.slice(0, 10);
}
