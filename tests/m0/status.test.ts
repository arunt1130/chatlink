import { describe, expect, it } from "vitest";
import { MemoryStore, makeEvent, tierOf } from "../../src";
import { messages, oneOfEach } from "../helpers/events";

const target = messages("krish", 1)[0]!;
const status = (author: string, s: "decided" | "closed" | "reopened" | "superseded", ts: string, id?: string) =>
  makeEvent(author, { kind: "status", target: target.id, status: s, reason: s }, { now: Date.parse(ts), id });

describe("M0 status resolution", () => {
  it("latest status by ts wins, regardless of ingest order", () => {
    const closed = status("krish", "closed", "2026-11-03T10:00:00Z");
    const reopened = status("arun", "reopened", "2026-11-04T10:00:00Z");
    const s1 = new MemoryStore();
    s1.ingest([target, closed, reopened]);
    const s2 = new MemoryStore();
    s2.ingest([reopened, closed, target]);
    expect(s1.resolveStatus(target.id)).toEqual(reopened);
    expect(s2.resolveStatus(target.id)).toEqual(reopened);
  });

  it("equal ts: the higher id wins", () => {
    const ts = "2026-11-03T10:00:00Z";
    const lo = status("krish", "closed", ts, "01JCXK00000000000000000000");
    const hi = status("arun", "decided", ts, "01JCXKZZZZZZZZZZZZZZZZZZZZ");
    const s1 = new MemoryStore();
    s1.ingest([hi, lo]);
    const s2 = new MemoryStore();
    s2.ingest([lo, hi]);
    expect(s1.resolveStatus(target.id)).toEqual(hi);
    expect(s2.resolveStatus(target.id)).toEqual(hi);
  });

  it("ts compares as an instant, not as a string (fractional seconds)", () => {
    const earlier = status("krish", "closed", "2026-11-03T10:00:05Z", "01JCXKZZZZZZZZZZZZZZZZZZZZ");
    const later = status("arun", "reopened", "2026-11-03T10:00:05.500Z", "01JCXK00000000000000000000");
    const s = new MemoryStore();
    s.ingest([later, earlier]);
    expect(s.resolveStatus(target.id)).toEqual(later);
  });

  it("no status → undefined", () => {
    const s = new MemoryStore();
    s.ingest([target]);
    expect(s.resolveStatus(target.id)).toBeUndefined();
  });

  it("tiers: status/note confirmed, message said, import imported, assistant_note model-written, unknown none", () => {
    expect(oneOfEach("krish").map(tierOf)).toEqual(["said", "confirmed", "confirmed", "model-written", "imported"]);
    expect(tierOf({ v: 1, id: target.id, author: "krish", ts: target.ts, kind: "poll" })).toBeNull();
  });
});
