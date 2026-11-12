import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WriteRefusedError, appendEvents, assertInsideMyDir, makeEvent } from "../../src";
import { messages } from "../helpers/events";
import { tmpDir } from "../helpers/tmp";

function trySymlink(target: string, link: string, type: "file" | "dir" | "junction" = "junction"): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

describe("M0 writer boundary", () => {
  it("refuses an event authored by someone else, writing nothing", () => {
    const root = tmpDir();
    const mine = messages("arun", 1);
    const theirs = messages("krish", 1);
    expect(() => appendEvents(root, "arun", [...mine, ...theirs])).toThrow(WriteRefusedError);
    expect(existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("refuses an invalid `me`", () => {
    const root = tmpDir();
    for (const me of ["../krish", "ARUN", "", "a/b", "..", "C:\\x"]) {
      expect(() => appendEvents(root, me, [])).toThrow(WriteRefusedError);
    }
  });

  it("refuses an invalid event in the batch, writing nothing", () => {
    const root = tmpDir();
    const [a] = messages("arun", 1);
    const bad = { ...makeEvent("arun", { kind: "message", text: "x" }), ts: "not a date" };
    expect(() => appendEvents(root, "arun", [a!, bad])).toThrow(WriteRefusedError);
    expect(existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("assertInsideMyDir refuses paths outside logs/<me>/", () => {
    const root = tmpDir();
    mkdirSync(path.join(root, "logs/arun"), { recursive: true });
    const ok = path.join(root, "logs/arun/2026-11-03.jsonl");
    expect(() => assertInsideMyDir(root, "arun", ok)).not.toThrow();
    for (const p of [
      path.join(root, "logs/krish/2026-11-03.jsonl"),
      path.join(root, "logs/arun/../krish/x.jsonl"),
      path.join(root, "logs/arun"),
      path.join(root, "space.json"),
      path.join(root, "logs/arunx/a.jsonl"),
      path.resolve("/etc/passwd"),
    ]) {
      expect(() => assertInsideMyDir(root, "arun", p), p).toThrow(WriteRefusedError);
    }
  });

  it("refuses when logs/<me> is a link pointing outside the repo", (ctx) => {
    const root = tmpDir();
    const outside = tmpDir();
    mkdirSync(path.join(root, "logs"), { recursive: true });
    if (!trySymlink(outside, path.join(root, "logs/arun"))) return ctx.skip();
    expect(() => appendEvents(root, "arun", messages("arun", 1))).toThrow(WriteRefusedError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses when logs/<me> links to another author's folder", (ctx) => {
    const root = tmpDir();
    mkdirSync(path.join(root, "logs/krish"), { recursive: true });
    if (!trySymlink(path.join(root, "logs/krish"), path.join(root, "logs/arun"))) return ctx.skip();
    expect(() => appendEvents(root, "arun", messages("arun", 1))).toThrow(WriteRefusedError);
    expect(readdirSync(path.join(root, "logs/krish"))).toEqual([]);
  });

  it("refuses when the day file is a dangling symlink", (ctx) => {
    const root = tmpDir();
    const [e] = messages("arun", 1);
    mkdirSync(path.join(root, "logs/arun"), { recursive: true });
    mkdirSync(path.join(root, "logs/krish"), { recursive: true });
    const victim = path.join(root, "logs/krish/2026-11-03.jsonl"); // does not exist yet
    if (!trySymlink(victim, path.join(root, "logs/arun/2026-11-03.jsonl"), "file")) return ctx.skip();
    expect(() => appendEvents(root, "arun", [e!])).toThrow(WriteRefusedError);
    expect(existsSync(victim)).toBe(false);
  });

  it("refuses when the day file is a symlink to an existing file elsewhere", (ctx) => {
    const root = tmpDir();
    const outside = tmpDir();
    const victim = path.join(outside, "victim.txt");
    writeFileSync(victim, "keep me\n");
    mkdirSync(path.join(root, "logs/arun"), { recursive: true });
    if (!trySymlink(victim, path.join(root, "logs/arun/2026-11-03.jsonl"), "file")) return ctx.skip();
    expect(() => appendEvents(root, "arun", messages("arun", 1))).toThrow(WriteRefusedError);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  it("refuses when the day path is a directory", () => {
    const root = tmpDir();
    mkdirSync(path.join(root, "logs/arun/2026-11-03.jsonl"), { recursive: true });
    expect(() => appendEvents(root, "arun", messages("arun", 1))).toThrow(WriteRefusedError);
  });

  it("refuses a differently-cased existing folder (logs/ARUN for arun) on case-insensitive filesystems", (ctx) => {
    const root = tmpDir();
    mkdirSync(path.join(root, "logs/ARUN"), { recursive: true });
    if (!existsSync(path.join(root, "logs/arun"))) return ctx.skip(); // case-sensitive FS: distinct folders
    expect(() => appendEvents(root, "arun", messages("arun", 1))).toThrow(WriteRefusedError);
    expect(readdirSync(path.join(root, "logs/ARUN"))).toEqual([]);
  });
});
