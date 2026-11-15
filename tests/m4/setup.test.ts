import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type GitRunner, GitTransport, LockedError, SERVER_LOCK_FILE, SHARED_FILES, acquireServerLock, readAllLogs, runGit, runProcess, syncFolderWarning } from "../../src";
import { openApp } from "../helpers/app";
import { makeSpace } from "../helpers/gitFixture";
import { tmpDir } from "../helpers/tmp";

/** A brand-new, empty "GitHub" repo and fresh clones of it, as on two new machines. */
function emptySpace(names = ["arun", "krish"]) {
  const base = tmpDir("chatlink-empty-");
  const gitconfig = path.join(base, "gitconfig");
  // No user.name/user.email on purpose: a fresh machine often has none.
  writeFileSync(gitconfig, "[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n");
  const env = { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const remote = path.join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const clones: Record<string, string> = {};
  for (const n of names) {
    clones[n] = path.join(base, n);
    git(base, "clone", "-q", remote, clones[n]!);
  }
  const transport = (n: string) => new GitTransport({ me: n, repoPath: clones[n]!, stateDir: path.join(base, "state", n), env, backoffMs: 20 });
  const fresh = () => {
    const d = path.join(base, `check-${Math.random().toString(36).slice(2)}`);
    git(base, "clone", "-q", remote, d);
    return d;
  };
  return { base, remote, env, git, clones, transport, fresh };
}

describe("M4 first-run setup", { timeout: 90_000 }, () => {
  it("on an empty repo, creates and shares .gitignore, .gitattributes and space.json, even without a git identity", async () => {
    const s = emptySpace(["arun"]);
    const t = s.transport("arun");
    const r = await t.setup();
    expect(r.created.sort()).toEqual([".gitattributes", ".gitignore", "space.json"]);
    expect(r.warnings).toEqual([]);
    await t.whenIdle();
    const check = s.fresh();
    for (const f of SHARED_FILES) expect(readFileSync(path.join(check, f.path), "utf8")).toBe(f.content);
    expect(s.git(check, "log", "-1", "--format=%an <%ae> %s").trim()).toBe("arun <arun@chatlink.invalid> chatlink: space setup");

    // A message works right after, and a second setup is a no-op.
    await t.appendMine([(await import("../../src")).makeEvent("arun", { kind: "message", text: "first!" })]);
    await t.whenIdle();
    expect((await t.setup()).created).toEqual([]);
    expect(readAllLogs(s.fresh()).events.map((e) => (e as { text: string }).text)).toEqual(["first!"]);
  });

  it("two people setting up a new repo at the same moment both succeed, with one copy of each file", async () => {
    const s = emptySpace();
    const [a, k] = [s.transport("arun"), s.transport("krish")];
    const [ra, rk] = await Promise.all([a.setup(), k.setup()]);
    expect(ra.created.length + rk.created.length).toBeGreaterThan(0);
    await Promise.all([a.whenIdle(), k.whenIdle()]);
    // Whoever lost the race pulls and finds the files already shared.
    await a.fetchNew();
    await k.fetchNew();
    await Promise.all([a.whenIdle(), k.whenIdle()]);
    const check = s.fresh();
    for (const f of SHARED_FILES) expect(readFileSync(path.join(check, f.path), "utf8")).toBe(f.content);
    expect(s.git(check, "status", "--porcelain")).toBe("");
    for (const n of ["arun", "krish"]) expect(s.git(s.clones[n]!, "status", "--porcelain")).toBe("");
  });

  it("an existing space is left alone; a hand-made .gitignore is never overwritten", async () => {
    const s = makeSpace();
    const app = openApp(s, "arun");
    await app.syncTurn({ message: "hi" });
    expect(readFileSync(path.join(s.clone("arun"), ".gitignore"), "utf8")).toBe(SHARED_FILES[0]!.content);

    const s2 = emptySpace(["arun"]);
    writeFileSync(path.join(s2.clones.arun!, ".gitignore"), "*.tmp\n");
    const r = await s2.transport("arun").setup();
    expect(r.warnings.join(" ")).toMatch(/\.gitignore exists .* left it alone/);
    expect(readFileSync(path.join(s2.clones.arun!, ".gitignore"), "utf8")).toBe("*.tmp\n");
    expect(r.created.sort()).toEqual([".gitattributes", "space.json"]);
  });

  it("warns when the clone has no upstream, and surfaces setup warnings in sync state", async () => {
    const s = emptySpace([]);
    const dir = path.join(s.base, "lonely");
    s.git(s.base, "init", "-q", "-b", "main", dir);
    const t = new GitTransport({ me: "arun", repoPath: dir, stateDir: path.join(s.base, "st"), env: s.env });
    expect((await t.setup()).warnings.join(" ")).toMatch(/no upstream/);
    await t.whenIdle();
  });

  it("flags clones inside file-sync folders", () => {
    expect(syncFolderWarning("C:\\Users\\a\\OneDrive\\Desktop\\space")).toMatch(/OneDrive/);
    expect(syncFolderWarning("C:\\Users\\a\\OneDrive - Contoso Ltd\\space")).toMatch(/OneDrive - Contoso/);
    expect(syncFolderWarning("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/space")).toMatch(/Mobile Documents/);
    expect(syncFolderWarning("/Users/a/Dropbox/space")).toMatch(/Dropbox/);
    expect(syncFolderWarning("C:\\Users\\a\\chatlink-space")).toBeNull();
    expect(syncFolderWarning("/home/a/boxes/space")).toBeNull();
  });
});

describe("M4 one server per clone", { timeout: 60_000 }, () => {
  it("a second process is refused while the first runs, and takes over once it's gone", async () => {
    const repo = tmpDir();
    mkdirSync(path.join(repo, ".git"));
    // Another live process holds the lock.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeFileSync(path.join(repo, ".git", SERVER_LOCK_FILE), `${child.pid}\n`);
      const t0 = Date.now();
      expect(() => acquireServerLock(repo, { waitMs: 500 })).toThrow(LockedError);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    } finally {
      child.kill();
    }
    await new Promise((r) => child.once("exit", r));
    // Its process is gone: the stale lock is taken over.
    const lock = acquireServerLock(repo, { waitMs: 500 });
    expect(readFileSync(lock.file, "utf8").trim()).toBe(String(process.pid));
    lock.release();
    expect(existsSync(lock.file)).toBe(false);
  });

  it("Chatlink holds the lock while open and releases it on close", async () => {
    const s = makeSpace();
    const app = openApp(s, "arun");
    const file = path.join(s.clone("arun"), ".git", SERVER_LOCK_FILE);
    expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid));
    await app.close();
    expect(existsSync(file)).toBe(false);
  });
});
