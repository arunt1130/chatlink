import { describe, expect, it } from "vitest";
import { RANKING, makeEvent, recencyFactor } from "../../src";
import { openIndex } from "../helpers/index";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
const m = (author: string, text: string, ageDays: number) => makeEvent(author, { kind: "message", text }, { now: NOW - ageDays * DAY });

describe("M2a recency ranking", () => {
  it("newer items outrank older equal matches", () => {
    const idx = openIndex();
    const old = m("krish", "Caching won't help here.", 40);
    const mid = m("arun", "Caching won't help here.", 10);
    const fresh = m("krish", "Caching won't help here.", 1);
    idx.ingest([mid, fresh, old]); // insert order must not matter
    const hits = idx.search("caching", { now: NOW });
    expect(hits.map((h) => h.id)).toEqual([fresh.id, mid.id, old.id]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
  });

  it("equal text and equal ts fall back to id order, deterministically", () => {
    const idx = openIndex();
    const a = m("arun", "deploy on friday", 2);
    const b = makeEvent("krish", { kind: "message", text: "deploy on friday" }, { now: Date.parse(a.ts) });
    idx.ingest([a, b]);
    const hits = idx.search("deploy", { now: NOW });
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id].sort().reverse());
  });

  it("a much better keyword match still beats a slightly newer weak one", () => {
    const idx = openIndex();
    const filler = Array.from({ length: 30 }, (_, i) => m("arun", `unrelated note number ${i} about lunch`, 3));
    const strong = m("krish", "caching caching: the caching layer won't help", 5);
    const weak = m("arun", "a long rambling message that only mentions caching once among many many other words here", 4);
    idx.ingest([...filler, strong, weak]);
    expect(idx.search("caching", { now: NOW })[0]!.id).toBe(strong.id);
  });

  it("recency weights are tunable in one place", () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(RANKING.recencyHalfLifeDays * DAY)).toBeCloseTo(RANKING.recencyFloor + (1 - RANKING.recencyFloor) / 2);
    expect(recencyFactor(10_000 * DAY)).toBeCloseTo(RANKING.recencyFloor);
    expect(recencyFactor(-5 * DAY)).toBe(1); // clock skew: future counts as now

    const idx = openIndex();
    const old = m("krish", "caching caching caching", 60);
    const fresh = m("arun", "caching and a few other words in a longer line", 1);
    idx.ingest([old, fresh]);
    // With recency off (floor 1), only keyword quality counts.
    expect(idx.search("caching", { now: NOW, ranking: { recencyFloor: 1 } })[0]!.id).toBe(old.id);
    // With a steep decay, the fresh one wins.
    expect(idx.search("caching", { now: NOW, ranking: { recencyFloor: 0, recencyHalfLifeDays: 1 } })[0]!.id).toBe(fresh.id);
  });
});
