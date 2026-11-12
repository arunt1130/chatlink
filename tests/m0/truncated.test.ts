import { appendFileSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvents, readAllLogs, readLogFile } from "../../src";
import { messages } from "../helpers/events";
import { tmpDir } from "../helpers/tmp";

describe("M0 truncated and malformed lines", () => {
  it("truncated last line: the reader skips it, keeps earlier events, and reports 1 skipped", () => {
    const root = tmpDir();
    const evs = messages("arun", 3);
    appendEvents(root, "arun", evs);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    const size = readFileSync(file).length;
    truncateSync(file, size - 10); // chop the end of the last line, including its \n
    const r = readLogFile(file);
    expect(r.events).toEqual(evs.slice(0, 2));
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ file, line: 3, reason: "invalid JSON" });
  });

  it("every truncation point of the last line is tolerated", () => {
    const root = tmpDir();
    const evs = messages("arun", 2);
    appendEvents(root, "arun", evs);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    const full = readFileSync(file);
    const firstLineEnd = full.indexOf(0x0a) + 1;
    for (let cut = firstLineEnd; cut < full.length; cut++) {
      writeFileSync(file, full.subarray(0, cut));
      const r = readLogFile(file);
      // Cutting only the trailing \n leaves a complete, valid last line.
      const lastComplete = cut === full.length - 1;
      expect(r.events).toEqual(lastComplete ? evs : evs.slice(0, 1));
      expect(r.skipped.length).toBe(lastComplete || cut === firstLineEnd ? 0 : 1);
    }
  });

  it("an append after a truncated line starts a fresh line and is readable", () => {
    const root = tmpDir();
    const [a, b, c] = messages("arun", 3);
    appendEvents(root, "arun", [a!, b!]);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    truncateSync(file, readFileSync(file).length - 7);
    appendEvents(root, "arun", [c!]);
    const r = readLogFile(file);
    expect(r.events).toEqual([a, c]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.line).toBe(2);
  });

  it("a malformed line mid-file is skipped and counted; the rest still read", () => {
    const root = tmpDir();
    const [a, b] = messages("arun", 2);
    appendEvents(root, "arun", [a!]);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    appendFileSync(file, '{"v":1,"id":"garbage\n{not json}\n[]\n');
    appendEvents(root, "arun", [b!]);
    const r = readAllLogs(root);
    expect(r.events).toEqual([a, b]);
    expect(r.skipped.map((s) => s.line)).toEqual([2, 3, 4]);
  });

  it("a cut inside a multi-byte UTF-8 character on the last line is skipped", () => {
    const root = tmpDir();
    const evs = messages("arun", 2, undefined, (i) => `é🎉漢字 ${i} 🎉🎉🎉`);
    appendEvents(root, "arun", evs);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    const full = readFileSync(file);
    const firstLineEnd = full.indexOf(0x0a) + 1;
    let sawInvalidUtf8 = false;
    for (let cut = firstLineEnd + 1; cut < full.length - 1; cut++) {
      writeFileSync(file, full.subarray(0, cut));
      const r = readLogFile(file);
      expect(r.events).toEqual(evs.slice(0, 1));
      expect(r.skipped).toHaveLength(1);
      if (r.skipped[0]!.reason === "invalid UTF-8") sawInvalidUtf8 = true;
    }
    expect(sawInvalidUtf8).toBe(true);
  });

  it("invalid UTF-8 bytes on a line between valid lines are skipped", () => {
    const root = tmpDir();
    const [a, b] = messages("arun", 2);
    appendEvents(root, "arun", [a!]);
    const file = path.join(root, "logs/arun/2026-11-03.jsonl");
    appendFileSync(file, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('"}\n')]));
    appendEvents(root, "arun", [b!]);
    const r = readLogFile(file);
    expect(r.events).toEqual([a, b]);
    expect(r.skipped).toEqual([{ file, line: 2, reason: "invalid UTF-8" }]);
  });

  it("an append after a valid last line with no trailing newline adds one first", () => {
    const root = tmpDir();
    const [a, b] = messages("arun", 2);
    const dir = path.join(root, "logs/arun");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "2026-11-03.jsonl");
    writeFileSync(file, JSON.stringify(a)); // no \n
    expect(readLogFile(file).events).toEqual([a]);
    appendEvents(root, "arun", [b!]);
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(a) + "\n" + JSON.stringify(b) + "\n");
    expect(readLogFile(file)).toEqual({ events: [a, b], skipped: [] });
  });

  it("a file with only garbage, or empty, does not crash", () => {
    const root = tmpDir();
    const dir = path.join(root, "logs/arun");
    appendEvents(root, "arun", messages("arun", 1));
    writeFileSync(path.join(dir, "2026-11-01.jsonl"), Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    writeFileSync(path.join(dir, "2026-11-02.jsonl"), "");
    const r = readAllLogs(root);
    expect(r.events).toHaveLength(1);
    expect(r.skipped).toEqual([{ file: path.join(dir, "2026-11-01.jsonl"), line: 1, reason: "invalid UTF-8" }]);
  });
});
