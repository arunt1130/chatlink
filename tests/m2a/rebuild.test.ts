import { appendFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Event, SqliteIndex, logFileFor, makeEvent, rebuildIndex, syncIndex } from "../../src";
import { main } from "../../src/cli";
import { makeSpace } from "../helpers/gitFixture";
import { openIndex, track } from "../helpers/index";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const QUERIES = ["caching", "should we cache results", "timestamp", "rejected", "deploy friday", "msg"];

let n = 0;
const at = (day: number) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T09:00:00.000Z`) + n++ * 1000;
const msg = (author: string, text: string, day: number) => makeEvent(author, { kind: "message", text }, { now: at(day) });

/** Everything observable about an index's contents. */
function snapshot(idx: SqliteIndex, targets: string[]) {
  return {
    size: idx.size,
    all: idx.all(),
    status: targets.map((t) => idx.resolveStatus(t) ?? null),
    search: QUERIES.map((q) => idx.search(q, { now: NOW, limit: 100 })),
  };
}

// Many real git round trips; slow on Windows under a parallel suite.
describe("M2a rebuild equals incremental ingest", { timeout: 120_000 }, () => {
  it("an index built turn by turn matches one rebuilt from the logs", async () => {
    const s = makeSpace();
    const arun = s.transport("arun");
    const krish = s.transport("krish");
    const inc = openIndex(path.join(s.stateDir("arun"), "index.sqlite"), { source: s.clone("arun") });

    const k1 = msg("krish", "Caching won't help here: every query has a unique timestamp in it.", 3);
    const targets = [k1.id];
    const turn = async (who: "arun" | "krish", events: Event[]) => {
      await (who === "arun" ? arun : krish).appendMine(events);
      await (who === "arun" ? arun : krish).whenIdle();
      await syncIndex(inc, arun); // arun's index follows along, one sync per turn
    };

    await turn("krish", [k1]);
    await turn("arun", [msg("arun", "Should we cache results for the dashboard?", 4)]);
    await turn("krish", [makeEvent("krish", { kind: "status", target: k1.id, status: "closed", reason: "caching idea rejected" }, { now: at(4) })]);
    await turn("arun", [msg("arun", "Let's not deploy on Friday.", 5), msg("arun", "msg one", 5)]);
    await turn("krish", [makeEvent("krish", { kind: "note", text: "Queries carry timestamps." }, { now: at(6) })]);

    // A sync with nothing new ingests nothing (incremental, not a full re-read).
    const idle = await syncIndex(inc, arun);
    expect(idle.ingest.added).toBe(0);

    // Arun goes offline for a turn: his index still picks up his own new event.
    s.goOffline("arun");
    await arun.appendMine([msg("arun", "offline thought about caching", 7)]);
    const off = await syncIndex(inc, arun);
    expect(off.sync.stale).toBe(true);
    expect(off.ingest.added).toBe(1);
    s.goOnline("arun");

    // Meanwhile krish reopens, with a status tie on ts (id breaks it), and
    // leaves a truncated line at the end of a file.
    const tieTs = at(8);
    const r1 = makeEvent("krish", { kind: "status", target: k1.id, status: "reopened", reason: "new data" }, { now: tieTs });
    const r2 = makeEvent("krish", { kind: "status", target: k1.id, status: "decided", reason: "keep it closed" }, { now: tieTs });
    await krish.appendMine([r1, r2]);
    await krish.whenIdle();
    appendFileSync(logFileFor(s.clone("krish"), "krish", r2.ts), '{"v":1,"id":"01JCX');
    s.git(s.clone("krish"), "commit", "-q", "-am", "partial line");
    s.git(s.clone("krish"), "push", "-q", "origin", "HEAD:refs/heads/main");
    const last = await syncIndex(inc, arun);
    await arun.whenIdle();
    expect(last.skipped.length).toBeGreaterThanOrEqual(1);

    const before = snapshot(inc, targets);
    expect(before.size).toBe(9);
    expect(before.status[0]?.id).toBe(r1.id < r2.id ? r2.id : r1.id);

    // Rebuild into a separate file from the same clone.
    const rebuiltFile = path.join(s.stateDir("arun"), "rebuilt.sqlite");
    const rebuilt = track((await rebuildIndex(rebuiltFile, arun, { source: s.clone("arun") })).index);
    expect(snapshot(rebuilt, targets)).toEqual(before);
    expect(rebuilt.cursor).toBe(inc.cursor);

    // And rebuilding the incremental index's own file in place gives the same.
    const incFile = inc.file;
    inc.close();
    const again = track((await rebuildIndex(incFile, arun, { source: s.clone("arun") })).index);
    expect(snapshot(again, targets)).toEqual(before);
  });

  it("the rebuild command deletes the index and rebuilds it from the logs", async () => {
    const s = makeSpace();
    const krish = s.transport("krish");
    const k1 = msg("krish", "Caching won't help here.", 3);
    await krish.appendMine([k1]);
    await krish.whenIdle();

    const file = path.join(s.stateDir("arun"), "index.sqlite");
    const stale = SqliteIndex.open(file, { source: s.clone("arun") });
    stale.ingest([msg("zed", "not in any log", 1)]); // junk the rebuild must drop
    stale.close();

    const logs: string[] = [];
    const orig = console.log;
    console.log = (x: string) => logs.push(x);
    try {
      const code = await main(["rebuild", "--repo", s.clone("arun"), "--me", "arun", "--state", s.stateDir("arun")], { env: s.env });
      expect(code).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(logs[0]!).indexed).toBe(1);
    const idx = openIndex(file, { source: s.clone("arun") });
    expect(idx.all().map((e) => e.id)).toEqual([k1.id]);
  });
});
