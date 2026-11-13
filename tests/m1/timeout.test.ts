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
    // The push blocks until the test opens the gate, so appendMine can only
    // return first if it really doesn't wait for delivery (no timing race).
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let pushStarted = false;
    let pushDone = false;
    const gatedPush: GitRunner = async (args, opts) => {
      if (args[0] !== "push") return runGit(args, opts);
      pushStarted = true;
      await gate;
      const r = await runGit(args, opts);
      pushDone = true;
      return r;
    };
    const a = s.transport("arun", { runGit: gatedPush });
    const e = makeEvent("arun", { kind: "message", text: "quick" });
    const r = await a.appendMine([e]);
    expect(r).toEqual({ written: 1, committed: true });
    expect(pushDone).toBe(false); // returned while delivery is still pending
    for (let i = 0; i < 100 && !pushStarted; i++) await new Promise((res) => setTimeout(res, 20));
    expect(pushStarted).toBe(true);
    open();
    await a.whenIdle();
    expect(pushDone).toBe(true);
    expect((await a.syncState()).unpushed).toBe(0);
    expect(ids(s.remoteEvents())).toEqual([e.id]);
  }, 60_000);
});
