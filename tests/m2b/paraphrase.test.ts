import { describe, expect, it } from "vitest";
import { type Event, makeEvent } from "../../src";
import { openIndex } from "../helpers/index";
import { realModel } from "../helpers/model";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
let n = 0;
const msg = (author: string, text: string, ageDays = 5) =>
  makeEvent(author, { kind: "message", text }, { now: NOW - ageDays * DAY + n++ * 1000 });

/** The motivating message plus distractors on other topics. */
function corpus(): { original: Event; all: Event[] } {
  const original = msg("krish", "Caching won't help here: every query has a unique timestamp in it.", 17);
  const all = [
    original,
    msg("arun", "Let's not deploy on Friday."),
    msg("krish", "I had pasta for lunch today."),
    msg("arun", "The login page needs a dark mode toggle."),
    msg("krish", "We decided to use Postgres instead of MySQL."),
    msg("arun", "Meet at the café to discuss résumés."),
    msg("krish", "The onboarding email goes out on Mondays."),
    msg("arun", "Can someone review my pull request for the parser?"),
    msg("krish", "Our test suite takes about a minute on Windows."),
    msg("arun", "Budget for the offsite is approved."),
  ];
  return { original, all };
}

describe("M2b a paraphrase finds the original", () => {
  it('"should we cache results" finds "caching won\'t help here"', () => {
    const { original, all } = corpus();
    const idx = openIndex(undefined, { embedder: realModel() });
    idx.ingest(all);
    const hits = idx.search("should we cache results", { now: NOW });
    expect(hits[0]!.id).toBe(original.id);
    expect(hits[0]).toMatchObject({ author: "krish", tier: "said", text: (original as { text: string }).text });
    expect(hits[0]!.match.vector).toBeGreaterThan(0.25);
  });

  it("vector search alone finds it (keyword weight 0)", () => {
    const { original, all } = corpus();
    const idx = openIndex(undefined, { embedder: realModel() });
    idx.ingest(all);
    const hits = idx.search("should we cache results", { now: NOW, ranking: { keywordWeight: 0 } });
    expect(hits[0]!.id).toBe(original.id);
  });

  it("finds paraphrases that share no word with the original", () => {
    const { all } = corpus();
    const byText = (t: string) => all.find((e) => (e as { text: string }).text.startsWith(t))!.id;
    const idx = openIndex(undefined, { embedder: realModel() });
    idx.ingest(all);
    const keywordOnly = openIndex();
    keywordOnly.ingest(all);
    const cases: [string, string][] = [
      ["store responses so repeat requests are faster", "Caching won't help here"],
      ["can we ship the release at the end of the week?", "Let's not deploy on Friday"],
      ["which database are we going with", "We decided to use Postgres"],
      ["theme switcher for the sign in screen", "The login page needs a dark mode"],
    ];
    for (const [q, want] of cases) {
      expect(idx.search(q, { now: NOW })[0]?.id, q).toBe(byText(want));
    }
    // Keyword search alone can't find the first one at all: vectors are doing the work.
    expect(keywordOnly.search(cases[0]![0], { now: NOW }).map((h) => h.id)).not.toContain(byText(cases[0]![1]));
  });

  it("does not return unrelated items as vector matches", () => {
    const { all } = corpus();
    const idx = openIndex(undefined, { embedder: realModel() });
    idx.ingest(all);
    const hits = idx.search("quantum chromodynamics lecture", { now: NOW });
    expect(hits.every((h) => h.match.keyword > 0 || h.match.vector >= 0.25)).toBe(true);
    expect(hits.length).toBeLessThan(all.length);
  });
});
