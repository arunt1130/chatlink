import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeEvent, readAllLogs, readLogFile, validateEvent } from "../../src";
import { messages } from "../helpers/events";
import { tmpDir } from "../helpers/tmp";

const good = { v: 1, id: "01JCXK2M9Q4E7R8T0000000000", author: "krish", ts: "2026-11-03T21:14:05Z", kind: "message", text: "hi" };

describe("M0 validation", () => {
  it("accepts the SPEC example shape (with a full-length ULID) and a UUIDv7 id", () => {
    expect(validateEvent(good).ok).toBe(true);
    expect(validateEvent({ ...good, id: "01932c07-a8f1-7c3e-9b2a-1f2e3d4c5b6a" }).ok).toBe(true);
  });

  it.each([
    ["missing v", { ...good, v: undefined }],
    ["v not an integer", { ...good, v: "1" }],
    ["missing id", { ...good, id: undefined }],
    ["id not ULID/UUIDv7", { ...good, id: "01JCXK2M9Q4E7R8T" }],
    ["missing author", { ...good, author: undefined }],
    ["uppercase author", { ...good, author: "Krish" }],
    ["path traversal author", { ...good, author: "../krish" }],
    ["author with slash", { ...good, author: "a/b" }],
    ["author too long", { ...good, author: "a".repeat(33) }],
    ["missing ts", { ...good, ts: undefined }],
    ["non-UTC ts", { ...good, ts: "2026-11-03T21:14:05+01:00" }],
    ["date-only ts", { ...good, ts: "2026-11-03" }],
    ["impossible ts", { ...good, ts: "2026-13-40T99:99:99Z" }],
    ["rolled-over date (Feb 30)", { ...good, ts: "2026-02-30T00:00:00Z" }],
    ["24:00 hour", { ...good, ts: "2026-11-03T24:00:00Z" }],
    ["sub-millisecond ts", { ...good, ts: "2026-11-03T21:14:05.0001Z" }],
    ["uppercase UUIDv7", { ...good, id: "01932C07-A8F1-7C3E-9B2A-1F2E3D4C5B6A" }],
    ["missing kind", { ...good, kind: undefined }],
    ["empty kind", { ...good, kind: "" }],
    ["message without text", { ...good, text: undefined }],
    ["status with bad value", { ...good, kind: "status", target: good.id, status: "maybe", reason: "" }],
    ["status without target", { ...good, kind: "status", status: "closed", reason: "" }],
    ["status without reason", { ...good, kind: "status", target: good.id, status: "closed" }],
    ["assistant_note without about", { ...good, kind: "assistant_note" }],
    ["import with bad role", { ...good, kind: "import", role: "system" }],
    ["import with bad original_ts", { ...good, kind: "import", role: "human", original_ts: "yesterday" }],
    ["array", [good]],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(validateEvent(value).ok).toBe(false);
  });

  it("makeEvent refuses an invalid author", () => {
    expect(() => makeEvent("../x", { kind: "message", text: "x" })).toThrow();
  });

  it("CRLF line endings and a BOM are tolerated", () => {
    const root = tmpDir();
    const dir = path.join(root, "logs/arun");
    mkdirSync(dir, { recursive: true });
    const evs = messages("arun", 2);
    const file = path.join(dir, "2026-11-03.jsonl");
    writeFileSync(file, "﻿" + evs.map((e) => JSON.stringify(e)).join("\r\n") + "\r\n");
    expect(readLogFile(file)).toEqual({ events: evs, skipped: [] });
  });

  it("an event in someone else's folder is skipped (author must match folder)", () => {
    const root = tmpDir();
    const dir = path.join(root, "logs/krish");
    mkdirSync(dir, { recursive: true });
    const [forged] = messages("arun", 1);
    writeFileSync(path.join(dir, "2026-11-03.jsonl"), JSON.stringify(forged) + "\n");
    const r = readAllLogs(root);
    expect(r.events).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toMatch(/does not match folder/);
  });

  it("folders and files outside the layout are ignored", () => {
    const root = tmpDir();
    mkdirSync(path.join(root, "logs/Not-A-Slug"), { recursive: true });
    mkdirSync(path.join(root, "logs/arun"), { recursive: true });
    writeFileSync(path.join(root, "logs/Not-A-Slug/2026-11-03.jsonl"), JSON.stringify(good) + "\n");
    writeFileSync(path.join(root, "logs/arun/notes.txt"), "hello");
    writeFileSync(path.join(root, "logs/stray.jsonl"), JSON.stringify(good) + "\n");
    expect(readAllLogs(root)).toEqual({ events: [], skipped: [] });
  });

  it("a missing logs/ folder gives an empty result", () => {
    expect(readAllLogs(tmpDir())).toEqual({ events: [], skipped: [] });
  });
});
