import { writeFileSync } from "node:fs";
import path from "node:path";
import { Db as Database } from "../../src/search/db";
import { describe, expect, it } from "vitest";
import { INDEX_SCHEMA_VERSION, MemoryStore, SqliteIndex, appendEvents, makeEvent, readAllLogs, syncIndex, toFtsQuery } from "../../src";
import { ids, messages, oneOfEach } from "../helpers/events";
import { makeSpace } from "../helpers/gitFixture";
import { openIndex } from "../helpers/index";
import { tmpDir } from "../helpers/tmp";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

describe("M2a SQLite index as an EventStore", () => {
  it("ingest is idempotent by id", () => {
    const idx = openIndex();
    const es = [...oneOfEach("krish"), ...messages("arun", 5)];
    expect(idx.ingest(es)).toEqual({ added: 10, duplicates: 0, conflicts: 0 });
    const before = idx.all();
    expect(idx.ingest(es)).toEqual({ added: 0, duplicates: 10, conflicts: 0 });
    expect(idx.ingest([es[0]!, es[0]!])).toEqual({ added: 0, duplicates: 2, conflicts: 0 });
    expect(idx.all()).toEqual(before);
    expect(idx.search("caching", { now: NOW })).toHaveLength(3); // message, status reason, assistant note
  });

  it("matches MemoryStore: merge equals union in any order, same status resolution and conflict rule", () => {
    const A = tmpDir();
    const B = tmpDir();
    const arun = messages("arun", 4, Date.parse("2026-11-03T08:00:00Z"));
    const krish = oneOfEach("krish", Date.parse("2026-11-03T09:00:00Z"));
    appendEvents(A, "arun", arun);
    appendEvents(A, "krish", krish.slice(0, 2));
    appendEvents(B, "krish", krish);
    appendEvents(B, "arun", arun.slice(0, 1));
    const a = readAllLogs(A).events;
    const b = readAllLogs(B).events;
    // A conflicting copy of one id (should never happen); both stores must keep the same one.
    const clash = { ...arun[1]!, text: "tampered" };

    const mem = new MemoryStore();
    mem.ingest([...a, clash, ...b]);
    const ab = openIndex();
    ab.ingest(a);
    ab.ingest([clash]);
    ab.ingest(b);
    const ba = openIndex();
    ba.ingest(b);
    ba.ingest([clash]);
    ba.ingest(a);

    expect(ids(ab.all())).toEqual(ids([...arun, ...krish]));
    expect(ab.all()).toEqual(mem.all());
    expect(ba.all()).toEqual(mem.all());
    for (const e of krish) expect(ab.resolveStatus(e.id)).toEqual(mem.resolveStatus(e.id));
    expect(ab.size).toBe(mem.size);
    expect(ab.has(arun[0]!.id)).toBe(true);
    expect(ab.get(arun[1]!.id)).toEqual(mem.get(arun[1]!.id));
  });

  it("persists across reopen; schema change or a different source repo wipes it", () => {
    const dir = tmpDir();
    const file = path.join(dir, "index.sqlite");
    const src = tmpDir();
    let idx = SqliteIndex.open(file, { source: src });
    idx.ingestAt(messages("arun", 3), "abc123");
    idx.close();

    idx = SqliteIndex.open(file, { source: src });
    expect(idx.size).toBe(3);
    expect(idx.cursor).toBe("abc123");
    idx.close();

    const other = tmpDir();
    idx = SqliteIndex.open(file, { source: other });
    expect(idx.size).toBe(0);
    expect(idx.cursor).toBeUndefined();
    idx.ingest(messages("arun", 2));
    idx.close();

    const raw = new Database(file);
    raw.pragma(`user_version = ${INDEX_SCHEMA_VERSION + 1}`);
    raw.close();
    idx = openIndex(file, { source: other });
    expect(idx.size).toBe(0);
  });

  it("replaces a corrupt index file instead of failing", () => {
    const file = path.join(tmpDir(), "index.sqlite");
    writeFileSync(file, "this is not a database, just junk bytes ".repeat(200));
    const idx = openIndex(file);
    idx.ingest(messages("arun", 1));
    expect(idx.size).toBe(1);
  });

  it("refuses an index file inside the shared repo, and never commits derived files", async () => {
    const s = makeSpace();
    expect(() => SqliteIndex.open(path.join(s.clone("arun"), "index.sqlite"), { source: s.clone("arun") })).toThrow(/outside/);
    expect(() => SqliteIndex.open(path.join(s.clone("arun"), "logs", "x.sqlite"), { source: s.clone("arun") })).toThrow(/outside/);

    const t = s.transport("arun");
    const idx = openIndex(path.join(s.stateDir("arun"), "index.sqlite"), { source: s.clone("arun") });
    await t.appendMine([makeEvent("arun", { kind: "message", text: "hello" })]);
    await syncIndex(idx, t);
    await t.whenIdle();
    expect(s.git(s.clone("arun"), "status", "--porcelain", "--ignored")).toBe("");
    expect(s.git(s.clone("arun"), "ls-files")).not.toMatch(/sqlite/);
  });
});

describe("M2a keyword search", () => {
  it("finds stemmed and diacritic variants; returns tier, verbatim text, and the item's status", () => {
    const idx = openIndex();
    const [msg, status, note, aNote, imp] = oneOfEach("krish");
    const cafe = makeEvent("arun", { kind: "message", text: "Meet at the Café to discuss résumé caches" });
    idx.ingest([msg!, status!, note!, aNote!, imp!, cafe]);

    const hits = idx.search("should we cache results?", { now: NOW });
    const hit = hits.find((h) => h.id === msg!.id)!;
    expect(hit).toMatchObject({ author: "krish", ts: msg!.ts, kind: "message", tier: "said", text: (msg as { text: string }).text, truncated: false });
    expect(hit.status).toMatchObject({ id: status!.id, status: "closed", reason: "caching idea rejected" });
    expect(hits.map((h) => h.id)).toContain(cafe.id);

    expect(idx.search("cafe resume", { now: NOW }).map((h) => h.id)).toEqual([cafe.id]);
    const tiers = Object.fromEntries(idx.search("caching rejected timestamps summary", { now: NOW, limit: 50 }).map((h) => [h.kind, h.tier]));
    expect(tiers).toMatchObject({ message: "said", status: "confirmed", note: "confirmed", assistant_note: "model-written" });
    expect(idx.search("old chat line", { now: NOW })[0]).toMatchObject({ kind: "import", tier: "imported" });
  });

  it("treats the query as plain words, never FTS syntax", () => {
    const idx = openIndex();
    idx.ingest(messages("arun", 3, undefined, (i) => `note ${i} about "quotes" and stars* and NEAR things`));
    for (const q of ['"', "*", "NEAR(", "a OR", "-x", "col:val", "(((", "AND", "^", "'; DROP TABLE events; --", "   ", ""]) {
      expect(() => idx.search(q, { now: NOW })).not.toThrow();
    }
    expect(idx.search("", { now: NOW })).toEqual([]);
    expect(idx.search("!!!", { now: NOW })).toEqual([]);
    expect(idx.search('"quotes"', { now: NOW })).toHaveLength(3);
    expect(toFtsQuery("Won't  won't WON'T")).toBe('"won" OR "t"');
    expect(idx.size).toBe(3);
  });

  it("filters by author and since, and clamps limit", () => {
    const idx = openIndex();
    const base = Date.parse("2026-11-01T00:00:00Z");
    idx.ingest([
      ...messages("arun", 30, base, (i) => `caching thought ${i}`),
      ...messages("krish", 5, base + 3_600_000, (i) => `caching idea ${i}`),
    ]);
    expect(idx.search("caching", { now: NOW }).length).toBe(10);
    expect(idx.search("caching", { now: NOW, limit: 1000 }).length).toBe(35);
    expect(idx.search("caching", { now: NOW, limit: 0 }).length).toBe(1);
    expect(idx.search("caching", { now: NOW, author: "krish", limit: 100 }).every((h) => h.author === "krish")).toBe(true);
    const since = new Date(base + 20_000).toISOString();
    const recent = idx.search("caching", { now: NOW, author: "arun", since, limit: 100 });
    expect(recent).toHaveLength(10);
    expect(recent.every((h) => Date.parse(h.ts) >= Date.parse(since))).toBe(true);
    expect(() => idx.search("caching", { since: "yesterday" })).toThrow(RangeError);
  });

  it("truncates long text and says so", () => {
    const idx = openIndex();
    const long = makeEvent("arun", { kind: "message", text: `caching ${"x".repeat(5000)}` });
    idx.ingest([long]);
    const [h] = idx.search("caching", { now: NOW, maxTextChars: 100 });
    expect(h).toMatchObject({ id: long.id, truncated: true, textLength: 5008 });
    expect(h!.text).toHaveLength(100);
    expect((idx.get(long.id) as { text: string }).text).toHaveLength(5008); // full text by id
  });
});
