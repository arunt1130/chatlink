import { describe, expect, it } from "vitest";
import { type GitRunner, makeEvent, runGit, runProcess } from "../../src";
import { ids } from "../helpers/events";
import { makeSpace } from "../helpers/gitFixture";
import { tmpDir } from "../helpers/tmp";

const node = process.execPath;
const hang = ["-e", "setInterval(() => {}, 1000)"];
// A parent that starts a grandchild sharing its stdout, then hangs.
const hangWithChild = [
  "-e",
  `require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000);`,
];

describe("M1 timeouts", () => {
  it("runProcess kills a hung command and returns promptly with timedOut", async () => {
    const t0 = Date.now();
    const r = await runProcess(node, hang, { cwd: tmpDir(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("runProcess returns promptly even when a grandchild holds the pipes", async () => {
    const t0 = Date.now();
    const r = await runProcess(node, hangWithChild, { cwd: tmpDir(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("runProcess reports a missing command instead of throwing", async () => {
    const r = await runProcess("definitely-not-a-command-xyz", [], { cwd: tmpDir() });
    expect(r.code).not.toBe(0);
  });

  it("a hung pull times out: the turn continues on local data and reports stale", async () => {
    const s = makeSpace();
    const a0 = s.transport("arun");
    const mine = makeEvent("arun", { kind: "message", text: "local" });
    await a0.appendMine([mine]);
    await a0.whenIdle();

    const hangingPull: GitRunner = (args, opts) =>
      args[0] === "pull" ? runProcess(node, hang, { cwd: opts.cwd, timeoutMs: opts.timeoutMs }) : runGit(args, opts);
    const a = s.transport("arun", { runGit: hangingPull, pullTimeoutMs: 300 });
    const t0 = Date.now();
    const f = await a.fetchNew();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(f.sync.stale).toBe(true);
    expect(f.sync.lastError).toMatch(/timed out/);
    expect(ids(f.events)).toEqual([mine.id]);
  }, 60_000);

  it("appendMine does not wait for the push", async () => {
    const s = makeSpace();
    const slowPush: GitRunner = async (args, opts) => {
      if (args[0] === "push") await new Promise((r) => setTimeout(r, 2000));
      return runGit(args, opts);
    };
    const a = s.transport("arun", { runGit: slowPush });
    const e = makeEvent("arun", { kind: "message", text: "quick" });
    const t0 = Date.now();
    await a.appendMine([e]);
    expect(Date.now() - t0).toBeLessThan(1800);
    await a.whenIdle();
    expect((await a.syncState()).unpushed).toBe(0);
    expect(ids(s.remoteEvents())).toEqual([e.id]);
  }, 60_000);
});
