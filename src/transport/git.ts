import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { type Event, AUTHOR_RE } from "../events/schema";
import { LOG_FILE_RE, WriteRefusedError, assertAuthor } from "../events/paths";
import { type Skipped, readAllLogs, readLogFile } from "../events/reader";
import { appendEvents } from "../events/writer";
import { type GitRunner, type ProcResult, runGit } from "./gitcli";
import { type PersistedState, loadState, saveState } from "./state";
import type { AppendMineResult, FetchResult, SyncState, Transport } from "./types";

export type GitTransportConfig = {
  /** My author slug; I write only logs/<me>/. */
  me: string;
  /** The local clone of the shared repo. */
  repoPath: string;
  /** Local-only state dir. Must be outside repoPath. */
  stateDir: string;
  pullTimeoutMs?: number;
  pushTimeoutMs?: number;
  /** Push attempts per delivery, each retry preceded by a pull. */
  pushAttempts?: number;
  /** Base backoff between push attempts. */
  backoffMs?: number;
  /** Extra environment for git (tests use it for hermetic config). */
  env?: NodeJS.ProcessEnv;
  /** Injectable git runner (tests use it to simulate hangs and count calls). */
  runGit?: GitRunner;
};

export const DEFAULTS = { pullTimeoutMs: 3000, pushTimeoutMs: 15000, pushAttempts: 3, backoffMs: 150 } as const;
/** Upper bound for local git commands so nothing can hang forever. */
const LOCAL_TIMEOUT_MS = 30000;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const LOG_PATH_RE = /^logs\/([^/]+)\/([^/]+)$/;
/**
 * chatlink's own commits are machine-written log appends: no signing prompt
 * (pinentry could hang a turn) and no user hooks.
 */
const COMMIT_FLAGS = ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q"];

export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    readonly result: ProcResult,
  ) {
    super(message);
  }
}

/** Serializes async work: local git operations never overlap in one clone. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn, fn);
    this.tail = r.catch(() => {});
    return r;
  }
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const ci = process.platform === "win32" || process.platform === "darwin";
  const rel = path.relative(ci ? parent.toLowerCase() : parent, ci ? child.toLowerCase() : child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const describe = (r: ProcResult) => (r.timedOut ? "timed out" : (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n")[0]!);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Lock files a killed git can leave behind, relative to the git dir (objects/ excluded). */
function findLockFiles(gitDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && (e.name === "objects" || e.name === "hooks")) continue;
        if (depth < 8) walk(p, depth + 1);
      } else if (e.name.endsWith(".lock")) out.push(p);
    }
  };
  walk(gitDir, 0);
  return out;
}

/**
 * Git transport over the user's own clone and credentials.
 * Durability: an event is durable once appendEvents returns (fsynced in the
 * clone). Commits are the offline queue; push is only delivery.
 *
 * Concurrency: local git work (recover, pull, commit, reads) is serialized by
 * a mutex. The network part of a push runs outside it, so a hung push never
 * delays a turn. It pushes an explicit commit SHA; the remote accepts only a
 * fast-forward, so a concurrent local rebase just turns it into a rejection
 * that the retry loop handles.
 */
export class GitTransport implements Transport {
  readonly me: string;
  readonly root: string;
  private readonly stateDir: string;
  private readonly cfg: Required<Omit<GitTransportConfig, "env" | "runGit">>;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly run: GitRunner;
  private readonly lock = new Mutex();
  private state: PersistedState;
  private stale = true;
  /** True when my log lines are known to be on disk but not committed. */
  private uncommitted = false;
  private pushing: Promise<void> | null = null;
  private pushAgain = false;
  private upstreamCache: { remote: string; merge: string } | null = null;

  constructor(config: GitTransportConfig) {
    assertAuthor(config.me);
    this.me = config.me;
    this.root = path.resolve(config.repoPath);
    this.stateDir = path.resolve(config.stateDir);
    if (isInsideOrEqual(this.stateDir, this.root)) {
      throw new Error(`stateDir must be outside the shared repo: ${this.stateDir}`);
    }
    this.cfg = { ...DEFAULTS, ...config, repoPath: this.root, stateDir: this.stateDir };
    this.env = config.env;
    this.run = config.runGit ?? runGit;
    this.state = loadState(this.stateDir);
  }

  // ---- Transport ----------------------------------------------------------

  /**
   * Throws WriteRefusedError only before anything is written. Once the events
   * are on disk it never throws: a failed commit is reported via sync state and
   * retried on the next cycle, so a caller never re-sends (and duplicates) them.
   */
  async appendMine(events: readonly Event[]): Promise<AppendMineResult> {
    const r = await this.lock.run(async () => {
      if (events.length === 0) return { written: 0, committed: false };
      appendEvents(this.root, this.me, events); // durable from here on
      const n = events.length;
      const committed = await this.tryCommit(`chatlink: ${this.me} +${n} event${n === 1 ? "" : "s"}`, true);
      return { written: n, committed };
    });
    if (r.committed) void this.schedulePush();
    return r;
  }

  async fetchNew(since?: string): Promise<FetchResult> {
    const { events, skipped, cursor, unpushed } = await this.lock.run(async () => {
      await this.pullLocked();
      const h = await this.git(["rev-parse", "--verify", "-q", "HEAD"]);
      const head = h.code === 0 ? h.stdout.trim() : ""; // "" = unborn HEAD (empty repo)
      const read = head ? await this.readChanged(since, head) : readAllLogs(this.root);
      return { ...read, cursor: head, unpushed: await this.unpushedCount() };
    });
    if (unpushed > 0) void this.schedulePush();
    return { events, skipped, cursor, sync: this.snapshot(unpushed) };
  }

  async syncState(): Promise<SyncState> {
    const unpushed = await this.lock.run(() => this.unpushedCount());
    return this.snapshot(unpushed);
  }

  async whenIdle(): Promise<void> {
    while (this.pushing) await this.pushing;
  }

  private snapshot(unpushed: number): SyncState {
    return {
      lastPullAt: this.state.lastPullAt,
      stale: this.stale,
      unpushed,
      uncommitted: this.uncommitted,
      lastPushAt: this.state.lastPushAt,
      lastError: this.state.lastError,
    };
  }

  // ---- pull ---------------------------------------------------------------

  /** Commits any of my uncommitted log lines (crash recovery), then pulls. Returns false when offline/failed. Never throws. */
  private async pullLocked(): Promise<boolean> {
    await this.tryCommit(`chatlink: ${this.me} recover uncommitted events`, false);
    const r = await this.git(["pull", "--rebase", "--autostash", "-q"], this.cfg.pullTimeoutMs);
    if (r.code === 0) {
      this.stale = false;
      this.state.lastPullAt = new Date().toISOString();
      if (!this.uncommitted) this.state.lastError = null;
      this.save();
      return true;
    }
    await this.cleanupAfterFailure(r);
    this.stale = true;
    this.recordError(`pull ${describe(r)}`);
    return false;
  }

  /** A failed pull can leave a rebase in progress; a killed one can leave lock files. */
  private async cleanupAfterFailure(r: ProcResult): Promise<void> {
    const gd = await this.git(["rev-parse", "--absolute-git-dir"]);
    const gitDir = gd.code === 0 ? gd.stdout.trim() : "";
    if (!gitDir) return;
    if (r.timedOut) {
      // The process tree is dead (runProcess waits for the kill). Only our own
      // git could hold these: one chatlink process per clone, git serialized.
      for (const f of findLockFiles(gitDir)) rmSync(f, { force: true });
    }
    if (existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"))) {
      await this.git(["rebase", "--abort"]);
    }
  }

  // ---- commit -------------------------------------------------------------

  private get mySpec(): string {
    return `:(glob)logs/${this.me}/*.jsonl`;
  }

  /** commitPending that records failures instead of throwing. */
  private async tryCommit(message: string, knownDirty: boolean): Promise<boolean> {
    try {
      const committed = await this.commitPending(message, knownDirty);
      this.uncommitted = false;
      return committed;
    } catch (e) {
      this.uncommitted = true;
      this.recordError(`commit failed (events are safe on disk, retried next turn): ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Stages and commits only logs/<me>/*.jsonl, then checks the commit touches
   * nothing else. Returns false when there was nothing to commit.
   */
  private async commitPending(message: string, knownDirty: boolean): Promise<boolean> {
    let hasLogs = false;
    try {
      hasLogs = readdirSync(path.join(this.root, "logs", this.me)).some((f) => LOG_FILE_RE.test(f));
    } catch {
      /* no folder yet */
    }
    if (!hasLogs) return false;
    if (!knownDirty) {
      // Cheap check first: the common case (every pull) has nothing to recover.
      const st = await this.ok(["status", "--porcelain", "-z", "--untracked-files=all", "--", this.mySpec]);
      if (st.stdout.length === 0) return false;
    }
    await this.ok(["add", "--", this.mySpec]);
    const d = await this.git(["diff", "--cached", "--quiet", "--", this.mySpec]);
    if (d.code === 0) return false;
    if (d.code !== 1) throw new GitError(`diff failed: ${describe(d)}`, d);
    await this.ok([...COMMIT_FLAGS, "-m", message, "--", this.mySpec]);

    const names = (await this.ok(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])).stdout
      .split("\0")
      .filter(Boolean);
    const prefix = `logs/${this.me}/`;
    const outside = names.filter((n) => !n.startsWith(prefix) || !n.endsWith(".jsonl"));
    if (outside.length > 0) {
      const parent = await this.git(["rev-parse", "--verify", "-q", "HEAD~1"]);
      if (parent.code === 0) await this.git(["reset", "-q", "--soft", "HEAD~1"]);
      else await this.git(["update-ref", "-d", "HEAD"]); // undo a root commit
      throw new WriteRefusedError(`refusing to commit outside ${prefix}: ${outside.join(", ")}`);
    }
    return true;
  }

  // ---- push ---------------------------------------------------------------

  /** Single-flight background delivery. Callers never await it on the reply path. */
  private schedulePush(): Promise<void> {
    if (this.pushing) {
      this.pushAgain = true;
      return this.pushing;
    }
    this.pushing = (async () => {
      try {
        do {
          this.pushAgain = false;
          await this.pushWithRetry();
        } while (this.pushAgain);
      } catch (e) {
        this.recordError(`push: ${(e as Error).message}`);
      } finally {
        this.pushing = null;
      }
    })();
    return this.pushing;
  }

  private async pushWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= this.cfg.pushAttempts; attempt++) {
      // Local part under the lock: what to push and where.
      const target = await this.lock.run(async () => {
        const h = await this.git(["rev-parse", "--verify", "-q", "HEAD"]);
        if (h.code !== 0) return null;
        return { sha: h.stdout.trim(), up: await this.upstream() };
      });
      if (!target) return;
      // Network part outside the lock, so turns never wait on it.
      const r = await this.git(["push", "-q", target.up.remote, `${target.sha}:${target.up.merge}`], this.cfg.pushTimeoutMs);
      if (r.code === 0) {
        this.state.lastPushAt = new Date().toISOString();
        if (!this.uncommitted) this.state.lastError = null;
        this.save();
        return;
      }
      this.recordError(`push ${describe(r)} (attempt ${attempt}/${this.cfg.pushAttempts})`);
      if (attempt === this.cfg.pushAttempts) return;
      // Likely a non-fast-forward: someone pushed first. Pull, then retry.
      await sleep(this.cfg.backoffMs * attempt + Math.random() * this.cfg.backoffMs);
      const pulled = await this.lock.run(() => this.pullLocked());
      if (!pulled) return; // offline: commits stay queued for the next turn
    }
  }

  /** Where HEAD pushes to (branch.<b>.remote / .merge). Looked up once per process. */
  private async upstream(): Promise<{ remote: string; merge: string }> {
    if (this.upstreamCache) return this.upstreamCache;
    const branch = (await this.ok(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    const r = await this.ok(["config", "--get-regexp", `^branch\\.${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(remote|merge)$`]);
    const get = (k: string) => r.stdout.split("\n").find((l) => l.startsWith(`branch.${branch}.${k} `))?.split(" ")[1]?.trim();
    const remote = get("remote");
    const merge = get("merge");
    if (!remote || !merge) throw new GitError(`branch ${branch} has no upstream`, r);
    this.upstreamCache = { remote, merge };
    return this.upstreamCache;
  }

  /** The offline queue: commits on HEAD that no remote-tracking ref has. */
  private async unpushedCount(): Promise<number> {
    const r = await this.git(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    const n = Number.parseInt(r.stdout.trim(), 10);
    return r.code === 0 && Number.isFinite(n) ? n : 0;
  }

  // ---- read ---------------------------------------------------------------

  /** Reads log files changed between `since` and `head`; everything when `since` is missing or unknown. */
  private async readChanged(since: string | undefined, head: string): Promise<{ events: Event[]; skipped: Skipped[] }> {
    if (since === head) return { events: [], skipped: [] };
    const known = since !== undefined && SHA_RE.test(since) && (await this.git(["cat-file", "-e", `${since}^{commit}`])).code === 0;
    if (!known) return readAllLogs(this.root);
    const names = (await this.ok(["diff", "--name-only", "-z", "--no-renames", since!, head, "--", "logs/"])).stdout
      .split("\0")
      .filter(Boolean);
    const events: Event[] = [];
    const skipped: Skipped[] = [];
    for (const name of names.sort()) {
      const m = LOG_PATH_RE.exec(name);
      if (!m || !AUTHOR_RE.test(m[1]!) || !LOG_FILE_RE.test(m[2]!)) continue;
      const file = path.join(this.root, name);
      if (!existsSync(file)) continue;
      const r = readLogFile(file, m[1]!);
      events.push(...r.events);
      skipped.push(...r.skipped);
    }
    return { events, skipped };
  }

  // ---- helpers ------------------------------------------------------------

  private git(args: string[], timeoutMs: number = LOCAL_TIMEOUT_MS): Promise<ProcResult> {
    return this.run(args, { cwd: this.root, env: this.env, timeoutMs });
  }

  private async ok(args: string[], timeoutMs?: number): Promise<ProcResult> {
    const r = await this.git(args, timeoutMs);
    if (r.code !== 0) throw new GitError(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? args[0]} ${describe(r)}`, r);
    return r;
  }

  private recordError(msg: string): void {
    this.state.lastError = msg;
    this.save();
  }

  private save(): void {
    try {
      saveState(this.stateDir, this.state);
    } catch {
      /* state is a convenience; never fail a turn over it */
    }
  }
}
