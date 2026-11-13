import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, type SearchHit, defaultStateDir, detectDecision, loadConfig } from "../../src";
import { tmpDir } from "../helpers/tmp";

const hit = (id: string, author: string, text: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  id,
  author,
  ts: "2026-11-03T21:14:05Z",
  kind: "message",
  tier: "said",
  text,
  truncated: false,
  textLength: text.length,
  score: 1,
  match: { keyword: 0.5, vector: 0.5 },
  ...extra,
});

describe("M3 decision detection (v1 heuristic)", () => {
  const rel = [hit("K1", "krish", "Caching won't help here: every query has a unique timestamp.")];
  it.each([
    ["Let's drop the caching idea.", "closed"],
    ["We're not going to build the cache.", "closed"],
    ["OK, ruled out.", "closed"],
    ["We decided to use Postgres.", "decided"],
    ["Let's go with option B", "decided"],
    ["Agreed on weekly releases.", "decided"],
  ])("%s → %s", (m, status) => {
    expect(detectDecision(m, "MINE", rel, "arun")?.status).toBe(status);
  });

  it.each(["Should we drop the caching idea?", "What did we decide about Postgres?", "Caching sounds useful.", ""])("no flag for %j", (m) => {
    expect(detectDecision(m, "MINE", rel, "arun")).toBeNull();
  });

  it("closing targets the related item from someone else; deciding targets this message", () => {
    const relevant = [hit("A0", "arun", "Should we cache results?"), ...rel];
    expect(detectDecision("Let's drop caching.", "MINE", relevant, "arun")).toMatchObject({ target: "K1", ask: expect.stringContaining("Caching won't help") });
    expect(detectDecision("We decided to use Postgres.", "MINE", relevant, "arun")).toMatchObject({ target: "MINE" });
  });

  it("off the record: no own id, so it can only target a related item (or nothing)", () => {
    expect(detectDecision("We decided to use Postgres.", null, [], "arun")).toBeNull();
    expect(detectDecision("Let's drop caching.", null, rel, "arun")?.target).toBe("K1");
  });

  it("doesn't re-suggest a status the item already has", () => {
    const closed = [hit("K1", "krish", "Caching won't help.", { status: { id: "S", author: "krish", ts: "2026-11-04T00:00:00Z", status: "closed", reason: "" } })];
    expect(detectDecision("Let's drop caching.", "MINE", closed, "arun")?.target).toBe("MINE");
  });
});

describe("M3 config", () => {
  const repo = () => {
    const r = tmpDir();
    mkdirSync(path.join(r, ".git"));
    return r;
  };

  it("reads CHATLINK_* env; flags win; defaults are per (me, clone) and outside the repo", () => {
    const r = repo();
    const c = loadConfig([], { CHATLINK_ME: "arun", CHATLINK_REPO: r, LOCALAPPDATA: "C:\\LAD", XDG_STATE_HOME: "/xdg" });
    expect(c).toMatchObject({ me: "arun", repoPath: path.resolve(r) });
    expect(c.stateDir).toBe(defaultStateDir("arun", r, { LOCALAPPDATA: "C:\\LAD", XDG_STATE_HOME: "/xdg" }));
    expect(c.indexFile).toBe(path.join(c.stateDir, "index.sqlite"));
    expect(defaultStateDir("arun", r)).not.toBe(defaultStateDir("arun", repo()));
    expect(loadConfig(["--me", "krish"], { CHATLINK_ME: "arun", CHATLINK_REPO: r }).me).toBe("krish");
    expect(loadConfig([], { CHATLINK_ME: "arun", CHATLINK_REPO: r, CHATLINK_MODEL_DIR: "none" }).modelDir).toBeNull();
  });

  it("refuses a missing or invalid name and a repo that isn't a git clone", () => {
    const r = repo();
    expect(() => loadConfig([], { CHATLINK_REPO: r })).toThrow(ConfigError);
    expect(() => loadConfig([], { CHATLINK_ME: "../krish", CHATLINK_REPO: r })).toThrow(/invalid name/);
    expect(() => loadConfig([], { CHATLINK_ME: "Arun", CHATLINK_REPO: r })).toThrow(/invalid name/);
    expect(() => loadConfig([], { CHATLINK_ME: "arun" })).toThrow(/CHATLINK_REPO/);
    expect(() => loadConfig([], { CHATLINK_ME: "arun", CHATLINK_REPO: tmpDir() })).toThrow(/not a git clone/);
  });
});
