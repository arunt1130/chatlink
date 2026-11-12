import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type Event, RANKING, SqliteIndex, makeEvent, rebuildIndex, scoreOf, syncIndex } from "../../src";
import { makeSpace } from "../helpers/gitFixture";
import { openIndex, track } from "../helpers/index";
import { bagEmbedder, realModel } from "../helpers/model";
import { tmpDir } from "../helpers/tmp";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
let n = 0;
const at = (ageDays: number) => ({ now: NOW - ageDays * DAY + n++ });
const msg = (author: string, text: string, ageDays = 3) => makeEvent(author, { kind: "message", text }, at(ageDays));

describe("M2b confirmed boost", () => {
  it("a note (confirmed) outranks an equal message (said), which outranks an assistant note (model-written)", () => {
    const idx = openIndex(undefined, { embedder: realModel() });
    const text = "Caching won't help here.";
    const said = msg("arun", text, 2);
    const note = makeEvent("krish", { kind: "note", text }, at(2));
    const model = makeEvent("arun", { kind: "assistant_note", text, about: said.id }, at(2));
    idx.ingest([model, said, note]);
    expect(idx.search("caching", { now: NOW }).map((h) => h.id)).toEqual([note.id, said.id, model.id]);
  });

  it("an item someone marked decided or closed outranks an equal unmarked one; reopened gets no boost", () => {
    const idx = openIndex(undefined, { embedder: realModel() });
    const a = msg("arun", "We should drop the cache layer.", 2);
    const b = msg("krish", "We should drop the cache layer.", 1); // newer, unmarked
    const close = makeEvent("krish", { kind: "status", target: a.id, status: "closed", reason: "agreed" }, at(1));
    idx.ingest([a, b, close]);
    const order = () => idx.search("drop cache layer", { now: NOW }).filter((h) => h.kind === "message").map((h) => h.id);
    expect(order()).toEqual([a.id, b.id]);
    expect(idx.search("drop cache layer", { now: NOW }).find((h) => h.id === a.id)?.status?.status).toBe("closed");

    idx.ingest([makeEvent("arun", { kind: "status", target: a.id, status: "reopened", reason: "new data" }, at(0.5))]);
    expect(order()).toEqual([b.id, a.id]); // back to plain recency
  });

  it("boosts are tunable in one place", () => {
    const base = { keyword: 0.5, vector: 0.5, ageMs: 0, status: null };
    expect(scoreOf({ ...base, tier: "confirmed" })).toBeCloseTo(0.5 * RANKING.tierBoost.confirmed);
    expect(scoreOf({ ...base, tier: "said", status: "decided" })).toBeCloseTo(0.5 * RANKING.statusBoost.decided);
    const idx = openIndex(undefined, { embedder: realModel() });
    const note = makeEvent("krish", { kind: "note", text: "deploy friday" }, at(5));
    const said = msg("arun", "deploy friday", 1);
    idx.ingest([note, said]);
    expect(idx.search("deploy friday", { now: NOW })[0]!.id).toBe(note.id);
    expect(idx.search("deploy friday", { now: NOW, ranking: { tierBoost: { confirmed: 1 } as never } })[0]!.id).toBe(said.id);
  });
});

describe("M2b hybrid search keeps M2a's guarantees", () => {
  it("newer items outrank older equal matches, with vectors on", () => {
    const idx = openIndex(undefined, { embedder: realModel() });
    const old = msg("krish", "Caching won't help here.", 40);
    const mid = msg("arun", "Caching won't help here.", 10);
    const fresh = msg("krish", "Caching won't help here.", 1);
    idx.ingest([mid, fresh, old]);
    expect(idx.search("should we cache results", { now: NOW }).map((h) => h.id)).toEqual([fresh.id, mid.id, old.id]);
  });

  it("author and since filters apply to vector matches too", () => {
    const idx = openIndex(undefined, { embedder: realModel() });
    const k = msg("krish", "Caching won't help here.", 10);
    const a = msg("arun", "Storing responses will not speed anything up.", 1);
    idx.ingest([k, a]);
    const q = "store responses so repeat requests are faster";
    expect(idx.search(q, { now: NOW, author: "krish" }).every((h) => h.author === "krish")).toBe(true);
    const since = new Date(NOW - 5 * DAY).toISOString();
    expect(idx.search(q, { now: NOW, since }).map((h) => h.id)).not.toContain(k.id);
  });
});

describe("M2b embeddings lifecycle", () => {
  it("events ingested without an embedder are embedded when opened with one", () => {
    const file = path.join(tmpDir(), "index.sqlite");
    const plain = SqliteIndex.open(file);
    const k = msg("krish", "Caching won't help here: every query has a unique timestamp in it.", 3);
    plain.ingest([k, msg("arun", "lunch was pasta")]);
    expect(plain.search("store responses so repeat requests are faster", { now: NOW })).toEqual([]);
    plain.close();
    const idx = openIndex(file, { embedder: realModel() });
    expect(idx.search("store responses so repeat requests are faster", { now: NOW })[0]?.id).toBe(k.id);
  });

  it("a different embedder re-embeds everything; the same one embeds nothing again", () => {
    const file = path.join(tmpDir(), "index.sqlite");
    const e1 = bagEmbedder("bag:v1");
    let idx = SqliteIndex.open(file, { embedder: e1 });
    idx.ingest([msg("arun", "one two"), msg("arun", "three four"), makeEvent("arun", { kind: "status", target: "01JCXK2M9Q4E7R8T00000000AA", status: "closed", reason: "done" }, at(1))]);
    expect(e1.calls).toBe(3); // status reasons are embedded too
    idx.close();

    const again = bagEmbedder("bag:v1");
    idx = SqliteIndex.open(file, { embedder: again });
    expect(again.calls).toBe(0);
    idx.close();

    const e2 = bagEmbedder("bag:v2", 32);
    idx = openIndex(file, { embedder: e2 });
    expect(e2.calls).toBe(3);
    const raw = new Database(file, { readonly: true });
    expect(raw.prepare("SELECT DISTINCT length(vec) AS n FROM vectors").pluck().all()).toEqual([32 * 4]);
    expect(raw.prepare("SELECT value FROM meta WHERE key = 'embedder'").pluck().get()).toBe("bag:v2");
    raw.close();
  });

  it("an id conflict re-embeds the kept event", () => {
    const em = bagEmbedder();
    const idx = openIndex(undefined, { embedder: em });
    const e = msg("arun", "zebra crossing");
    const tampered = { ...e, text: "aardvark burrow" } as Event; // canonically smaller ("a" < "z")
    idx.ingest([e]);
    idx.ingest([tampered]);
    expect(idx.search("aardvark", { now: NOW, ranking: { keywordWeight: 0, minVectorSim: 0.5 } })[0]?.id).toBe(e.id);
    expect(idx.search("zebra", { now: NOW, ranking: { keywordWeight: 0, minVectorSim: 0.5 } })).toEqual([]);
  });
});

describe("M2b rebuild equals incremental ingest, with vectors", { timeout: 120_000 }, () => {
  it("vector and hybrid results match after a rebuild", async () => {
    const s = makeSpace();
    const arun = s.transport("arun");
    const krish = s.transport("krish");
    const em = realModel();
    const inc = openIndex(path.join(s.stateDir("arun"), "index.sqlite"), { source: s.clone("arun"), embedder: em });
    const k1 = msg("krish", "Caching won't help here: every query has a unique timestamp in it.", 17);
    for (const [t, es] of [
      [krish, [k1]],
      [arun, [msg("arun", "Let's not deploy on Friday.", 9)]],
      [krish, [makeEvent("krish", { kind: "status", target: k1.id, status: "closed", reason: "caching idea rejected" }, at(8))]],
      [arun, [makeEvent("arun", { kind: "note", text: "We use Postgres." }, at(2))]],
    ] as const) {
      await t.appendMine(es as unknown as Event[]);
      await t.whenIdle();
      await syncIndex(inc, arun);
    }
    await arun.whenIdle();
    const queries = ["should we cache results", "store responses so repeat requests are faster", "which database", "ship it friday"];
    const snap = (idx: SqliteIndex) => ({ all: idx.all(), search: queries.map((q) => idx.search(q, { now: NOW, limit: 100 })) });
    const before = snap(inc);
    // Krish's message, or his (confirmed) status closing it, leads.
    expect(before.search[1]!.slice(0, 2).map((h) => h.id)).toContain(k1.id);

    const rebuilt = track((await rebuildIndex(path.join(s.stateDir("arun"), "rebuilt.sqlite"), arun, { source: s.clone("arun"), embedder: em })).index);
    expect(snap(rebuilt)).toEqual(before);
  });
});
