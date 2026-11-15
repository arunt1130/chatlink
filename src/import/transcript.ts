import { createHash } from "node:crypto";
import { type Event, type ImportRole, makeEvent } from "../events/schema";

/**
 * Importing an older chat (SPEC "Importing an existing chat"): split a
 * transcript into turns and turn the author's turns into `import` events,
 * verbatim. Never summarizes. Ids are derived from the transcript and each
 * turn's position, so re-running the same import adds nothing.
 *
 * Accepted inputs:
 *  - A Claude.ai data export (`conversations.json`): one conversation object,
 *    or the whole array (then pick one with `conversation`, by uuid or name).
 *  - A JSON array of turns: [{ role | sender, text | content, ts | created_at }].
 *  - Plain text with speaker labels at line starts: "Human:" or "User:" for
 *    the author, "Assistant:" or "Claude:" for Claude. Only these four, so an
 *    ordinary line starting "Me:" or "AI:" inside a message stays in it.
 */
export type Turn = { role: ImportRole; text: string; ts?: string };
export type Transcript = { key: string; title: string | null; turns: Turn[] };

export class ImportError extends Error {
  override name = "ImportError";
}

const HUMAN = new Set(["human", "user", "me", "you", "h"]);
const ASSISTANT = new Set(["assistant", "claude", "ai", "a", "model", "bot"]);

function roleOf(x: unknown): ImportRole | null {
  const r = typeof x === "string" ? x.trim().toLowerCase() : "";
  if (HUMAN.has(r)) return "human";
  if (ASSISTANT.has(r)) return "assistant";
  return null;
}

/** ISO 8601 UTC with at most milliseconds (what the event schema accepts), or undefined. */
function normTs(x: unknown): string | undefined {
  if (typeof x !== "string" && typeof x !== "number") return undefined;
  const ms = typeof x === "number" ? (x < 1e12 ? x * 1000 : x) : Date.parse(x);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function textOf(m: Record<string, unknown>): string {
  if (typeof m.text === "string" && m.text.trim() !== "") return m.text;
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fromClaudeConversation(c: Record<string, unknown>): Transcript {
  const msgs = Array.isArray(c.chat_messages) ? (c.chat_messages as Record<string, unknown>[]) : [];
  const turns: Turn[] = [];
  for (const m of msgs) {
    const role = roleOf(m.sender ?? m.role);
    const text = textOf(m);
    if (role && text.trim() !== "") turns.push({ role, text, ts: normTs(m.created_at ?? m.timestamp) });
  }
  const uuid = typeof c.uuid === "string" ? c.uuid : null;
  const title = typeof c.name === "string" ? c.name : null;
  return { key: uuid ? `claude:${uuid}` : `sha:${sha(JSON.stringify(msgs))}`, title, turns };
}

export function parseTranscript(content: string, opts: { conversation?: string } = {}): Transcript {
  // Line endings don't change identity: re-saving a transcript with CRLF re-imports nothing.
  const trimmed = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (trimmed === "") throw new ImportError("the transcript is empty");

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      throw new ImportError(`not valid JSON: ${(e as Error).message}`);
    }
    const isConv = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && Array.isArray((x as { chat_messages?: unknown }).chat_messages);
    if (isConv(json)) return fromClaudeConversation(json);
    if (Array.isArray(json) && json.length && json.every(isConv)) {
      const convs = json as Record<string, unknown>[];
      if (convs.length === 1) return fromClaudeConversation(convs[0]!);
      const want = opts.conversation?.trim().toLowerCase();
      if (!want) {
        const names = convs.slice(0, 20).map((c) => `  - ${String(c.name ?? "(untitled)")} [${String(c.uuid ?? "?")}]`).join("\n");
        throw new ImportError(`this export has ${convs.length} conversations; pick one by name or uuid. Some of them:\n${names}`);
      }
      const hits = convs.filter((c) => String(c.uuid ?? "").toLowerCase() === want || String(c.name ?? "").toLowerCase().includes(want));
      if (hits.length !== 1) throw new ImportError(`${hits.length} conversations match ${JSON.stringify(opts.conversation)}; be more specific (or use the uuid)`);
      return fromClaudeConversation(hits[0]!);
    }
    if (Array.isArray(json)) {
      const turns: Turn[] = [];
      json.forEach((m, i) => {
        if (!m || typeof m !== "object") throw new ImportError(`turn ${i + 1} is not an object`);
        const o = m as Record<string, unknown>;
        const role = roleOf(o.role ?? o.sender ?? o.author);
        if (!role) throw new ImportError(`turn ${i + 1}: unknown role ${JSON.stringify(o.role ?? o.sender ?? o.author)}`);
        const text = textOf(o);
        if (text.trim() !== "") turns.push({ role, text, ts: normTs(o.ts ?? o.created_at ?? o.timestamp) });
      });
      return { key: `sha:${sha(trimmed)}`, title: null, turns };
    }
    throw new ImportError("unrecognized JSON: expected a Claude export conversation or an array of turns");
  }

  // Plain text with speaker labels.
  const label = /^(human|user|assistant|claude)\s*:\s?(.*)$/i;
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const line of trimmed.split("\n")) {
    const m = line.match(label);
    if (m) {
      if (cur) turns.push(cur);
      cur = { role: roleOf(m[1])!, text: m[2] ?? "" };
    } else if (cur) cur.text += `\n${line}`;
    else if (line.trim() !== "") throw new ImportError('text transcripts need speaker labels at the start of lines, e.g. "Human:" and "Assistant:"');
  }
  if (cur) turns.push(cur);
  const clean = turns.map((t) => ({ ...t, text: t.text.replace(/\s+$/, "") })).filter((t) => t.text.trim() !== "");
  if (!clean.length) throw new ImportError("no turns found");
  return { key: `sha:${sha(trimmed)}`, title: null, turns: clean };
}

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID whose time part is the turn's original time (0 when unknown) and
 * whose random part comes from a hash of (author, transcript, position, role,
 * text). Same input, same id.
 */
export function importId(author: string, key: string, position: number, turn: Turn): string {
  const h = createHash("sha256").update(`chatlink-import\0${author}\0${key}\0${position}\0${turn.role}\0${turn.text}`).digest();
  let t = turn.ts ? Math.max(0, Math.min(2 ** 48 - 1, Date.parse(turn.ts))) : 0;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = BigInt(`0x${h.subarray(0, 10).toString("hex")}`);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = ENC[Number(r & 31n)] + rand;
    r >>= 5n;
  }
  return time + rand;
}

/** The import events for `author`'s side (and, if asked, Claude's turns as role "assistant"). */
export function importEvents(author: string, t: Transcript, opts: { includeAssistant?: boolean; now?: number } = {}): Event[] {
  const now = opts.now ?? Date.now();
  const out: Event[] = [];
  t.turns.forEach((turn, i) => {
    if (turn.role === "assistant" && !opts.includeAssistant) return;
    const fields = { kind: "import" as const, text: turn.text, role: turn.role, ...(turn.ts ? { original_ts: turn.ts } : {}) };
    out.push(makeEvent(author, fields, { now, id: importId(author, t.key, i, turn) }));
  });
  return out;
}
