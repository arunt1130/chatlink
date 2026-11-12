import { cpSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, appendEvents, readAllLogs } from "../../src";
import { ids, messages, oneOfEach } from "../helpers/events";
import { tmpDir } from "../helpers/tmp";

describe("M0 merge equals union", () => {
  it("merging two logs equals their union, in any order", () => {
    // Two clones that each saw some shared history plus their own new events.
    const arunEvents = messages("arun", 4, Date.parse("2026-11-03T08:00:00Z"));
    const krishEvents = oneOfEach("krish", Date.parse("2026-11-03T09:00:00Z"));

    const A = tmpDir();
    const B = tmpDir();
    appendEvents(A, "arun", arunEvents);
    appendEvents(A, "krish", krishEvents.slice(0, 2)); // A already has some of krish
    appendEvents(B, "krish", krishEvents);
    appendEvents(B, "arun", arunEvents.slice(0, 1)); // B already has some of arun

    const a = readAllLogs(A).events;
    const b = readAllLogs(B).events;
    const union = ids([...new Map([...a, ...b].map((e) => [e.id, e])).values()]);
    expect(union).toEqual(ids([...arunEvents, ...krishEvents]));

    const ab = new MemoryStore();
    ab.ingest(a);
    ab.ingest(b);
    const ba = new MemoryStore();
    ba.ingest(b);
    ba.ingest(a);
    const both = new MemoryStore();
    both.ingest([...a, ...b]);

    expect(ids(ab.all())).toEqual(union);
    expect(ab.all()).toEqual(ba.all());
    expect(ab.all()).toEqual(both.all());
    const target = krishEvents[0]!.id;
    expect(ab.resolveStatus(target)).toEqual(ba.resolveStatus(target));
    expect(ab.resolveStatus(target)?.status).toBe("closed");
  });

  it("all() is ordered by ts then id", () => {
    const root = tmpDir();
    const t = Date.parse("2026-11-03T08:00:00Z");
    appendEvents(root, "krish", messages("krish", 3, t + 500));
    appendEvents(root, "arun", messages("arun", 3, t));
    const store = new MemoryStore();
    store.ingest(readAllLogs(root).events);
    const all = store.all();
    for (let i = 1; i < all.length; i++) {
      const p = all[i - 1]!;
      const c = all[i]!;
      expect(Date.parse(p.ts) < Date.parse(c.ts) || (p.ts === c.ts && p.id < c.id)).toBe(true);
    }
  });

  it("reading a folder union of two repos gives the union of their events", () => {
    const A = tmpDir();
    const B = tmpDir();
    const ae = messages("arun", 2);
    const ke = messages("krish", 2);
    appendEvents(A, "arun", ae);
    appendEvents(B, "krish", ke);
    const merged = tmpDir();
    cpSync(path.join(A, "logs"), path.join(merged, "logs"), { recursive: true });
    cpSync(path.join(B, "logs"), path.join(merged, "logs"), { recursive: true });
    expect(ids(readAllLogs(merged).events)).toEqual(ids([...ae, ...ke]));
  });
});
