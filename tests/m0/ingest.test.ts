import { copyFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Event, MemoryStore, appendEvents, makeEvent, readAllLogs } from "../../src";
import { ids, messages, oneOfEach } from "../helpers/events";
import { tmpDir } from "../helpers/tmp";

describe("M0 idempotent ingest", () => {
  it("ingesting a log twice changes nothing", () => {
    const root = tmpDir();
    appendEvents(root, "krish", oneOfEach("krish"));
    const store = new MemoryStore();
    const first = store.ingest(readAllLogs(root).events);
    expect(first).toEqual({ added: 5, duplicates: 0, conflicts: 0 });
    const snapshot = store.all();
    const status = store.resolveStatus(snapshot[0]!.id);

    const second = store.ingest(readAllLogs(root).events);
    expect(second).toEqual({ added: 0, duplicates: 5, conflicts: 0 });
    expect(store.all()).toEqual(snapshot);
    expect(store.size).toBe(5);
    expect(store.resolveStatus(snapshot[0]!.id)).toEqual(status);
  });

  it("the same event repeated within one batch is added once", () => {
    const [a] = messages("arun", 1);
    const store = new MemoryStore();
    expect(store.ingest([a!, a!, { ...a! }])).toEqual({ added: 1, duplicates: 2, conflicts: 0 });
  });

  it("a duplicate written twice to the log is still one event", () => {
    const root = tmpDir();
    const [a] = messages("arun", 1);
    appendEvents(root, "arun", [a!]);
    appendEvents(root, "arun", [a!]);
    const store = new MemoryStore();
    store.ingest(readAllLogs(root).events);
    expect(store.size).toBe(1);
  });

  it("key order does not make an identical event look different", () => {
    const [a] = messages("arun", 1);
    const reordered = Object.fromEntries(Object.entries(a!).reverse()) as Event;
    const store = new MemoryStore();
    store.ingest([a!]);
    expect(store.ingest([reordered])).toEqual({ added: 0, duplicates: 1, conflicts: 0 });
  });

  it("the same id read from two different day files on disk is one event", () => {
    const root = tmpDir();
    const [a] = messages("arun", 1);
    appendEvents(root, "arun", [a!]);
    const dir = path.join(root, "logs/arun");
    copyFileSync(path.join(dir, "2026-11-03.jsonl"), path.join(dir, "2026-11-04.jsonl"));
    const read = readAllLogs(root).events;
    expect(read).toHaveLength(2);
    const store = new MemoryStore();
    expect(store.ingest(read)).toEqual({ added: 1, duplicates: 1, conflicts: 0 });
  });

  it("an id conflict on a status event re-resolves status the same way in either order", () => {
    const [target] = messages("krish", 1);
    const s = makeEvent("krish", { kind: "status", target: target!.id, status: "closed", reason: "a" });
    const s2 = { ...s, status: "reopened", reason: "b" } as Event;
    const x = new MemoryStore();
    x.ingest([target!, s, s2]);
    const y = new MemoryStore();
    y.ingest([s2, target!, s]);
    expect(x.resolveStatus(target!.id)).toEqual(y.resolveStatus(target!.id));
    expect(x.resolveStatus(target!.id)).toBeDefined();
  });

  it("two different events with one id: a conflict, resolved the same way in either order", () => {
    const [a] = messages("arun", 1);
    const b = { ...a!, text: "different" } as Event;
    const s1 = new MemoryStore();
    const s2 = new MemoryStore();
    expect(s1.ingest([a!, b]).conflicts).toBe(1);
    expect(s2.ingest([b, a!]).conflicts).toBe(1);
    expect(s1.all()).toEqual(s2.all());
    expect(ids(s1.all())).toEqual([a!.id]);
  });
});
