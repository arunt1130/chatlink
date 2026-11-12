import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvents, makeEvent, readAllLogs, readLogFile } from "../../src";
import { messages, oneOfEach } from "../helpers/events";
import { tmpDir } from "../helpers/tmp";

describe("M0 round trip", () => {
  it("round trip: one event of each kind written then read back deep-equal", () => {
    const root = tmpDir();
    const events = oneOfEach("krish");
    appendEvents(root, "krish", events);
    const r = readAllLogs(root);
    expect(r.skipped).toEqual([]);
    expect(r.events).toEqual(events);
  });

  it("writes to logs/<author>/<UTC day>.jsonl, one JSON object per line, LF-terminated", () => {
    const root = tmpDir();
    const events = oneOfEach("krish");
    const res = appendEvents(root, "krish", events);
    const file = path.join(root, "logs", "krish", "2026-11-03.jsonl");
    expect(res).toEqual([{ file, count: events.length }]);
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.includes("\r")).toBe(false);
    const lines = raw.split("\n").slice(0, -1);
    expect(lines.map((l) => JSON.parse(l))).toEqual(events);
  });

  it("splits events across UTC days by each event's own ts", () => {
    const root = tmpDir();
    // 23:59:59 UTC and 00:00:01 UTC next day.
    const a = makeEvent("arun", { kind: "message", text: "late" }, { now: Date.parse("2026-11-12T23:59:59Z") });
    const b = makeEvent("arun", { kind: "message", text: "early" }, { now: Date.parse("2026-11-13T00:00:01Z") });
    appendEvents(root, "arun", [a, b]);
    expect(readLogFile(path.join(root, "logs/arun/2026-11-12.jsonl")).events).toEqual([a]);
    expect(readLogFile(path.join(root, "logs/arun/2026-11-13.jsonl")).events).toEqual([b]);
  });

  it("appends across calls without rewriting earlier lines", () => {
    const root = tmpDir();
    const [a, b, c] = messages("arun", 3);
    appendEvents(root, "arun", [a!]);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    const before = readFileSync(file);
    appendEvents(root, "arun", [b!, c!]);
    const after = readFileSync(file);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(readLogFile(file).events).toEqual([a, b, c]);
  });

  it("keeps text verbatim, including unicode, quotes, newlines and U+2028", () => {
    const root = tmpDir();
    const text = 'He said "no".\nSecond line\ttab ' + String.fromCharCode(0x2028) + " sep — émoji 🎉 \\ backslash";
    const lone = "lone surrogate " + String.fromCharCode(0xd800) + " end";
    expect(text.includes(" ")).toBe(true);
    const e = makeEvent("arun", { kind: "message", text });
    const f = makeEvent("arun", { kind: "message", text: lone });
    appendEvents(root, "arun", [e, f]);
    const r = readAllLogs(root);
    expect(r.skipped).toEqual([]);
    expect(r.events.map((x) => (x as { text: string }).text)).toEqual([text, lone]);
  });

  it("keeps unknown extra fields and unknown kinds (forward compatible)", () => {
    const root = tmpDir();
    const e = { ...makeEvent("arun", { kind: "message", text: "x" }), extra: { nested: [1, 2] } };
    const future = { v: 1, id: "01JCXK7B3W1N2P5S0000000000", author: "arun", ts: e.ts, kind: "poll", q: "?" };
    appendEvents(root, "arun", [e, future]);
    expect(readAllLogs(root).events).toEqual([e, future]);
  });

  it("an empty append writes nothing", () => {
    const root = tmpDir();
    expect(appendEvents(root, "arun", [])).toEqual([]);
    expect(existsSync(path.join(root, "logs"))).toBe(false);
  });
});
