import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isAuthor } from "./events/schema";

/** models/potion-base-32M beside the program (dist/.. or src/..). */
export const DEFAULT_MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "models", "potion-base-32M");

export type ChatlinkConfig = {
  /** My author slug: my folder under logs/. */
  me: string;
  /** My local clone of the shared repo. */
  repoPath: string;
  /** Local-only state (sync state, read cursor, index). Outside the repo. */
  stateDir: string;
  /** The index file (default <stateDir>/index.sqlite). */
  indexFile: string;
  /** Embedding model folder, or null for keyword-only search. */
  modelDir: string | null;
  pullTimeoutMs?: number;
  /** Extra environment for git (tests). */
  gitEnv?: NodeJS.ProcessEnv;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A per-user data folder: %LOCALAPPDATA% on Windows, Application Support on macOS, XDG state elsewhere. */
export function defaultDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "chatlink");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "chatlink");
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "chatlink");
}

/** One state dir per (me, clone), so two server entries on one machine never share state. */
export function defaultStateDir(me: string, repoPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const h = createHash("sha256").update(path.resolve(repoPath).toLowerCase()).digest("hex").slice(0, 10);
  return path.join(defaultDataRoot(env), `${me}-${h}`);
}

/**
 * Reads config from command-line flags, then CHATLINK_* environment variables
 * (what a Claude Desktop config or MCPB user_config sets):
 *   --me / CHATLINK_ME, --repo / CHATLINK_REPO (required)
 *   --state / CHATLINK_STATE_DIR, --index / CHATLINK_INDEX,
 *   --model / CHATLINK_MODEL_DIR ("none" = keyword-only)
 */
export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ChatlinkConfig {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: { me: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, index: { type: "string" }, model: { type: "string" } },
  });
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const me = str(values.me) ?? str(env.CHATLINK_ME);
  const repo = str(values.repo) ?? str(env.CHATLINK_REPO);
  if (!me) throw new ConfigError("missing your name: set CHATLINK_ME (or --me)");
  if (!isAuthor(me)) throw new ConfigError(`invalid name ${JSON.stringify(me)}: use lowercase letters, digits, - or _ (e.g. "arun")`);
  if (!repo) throw new ConfigError("missing the path to your clone of the shared repo: set CHATLINK_REPO (or --repo)");
  const repoPath = path.resolve(repo);
  if (!isDir(repoPath)) throw new ConfigError(`CHATLINK_REPO is not a folder: ${repoPath}`);
  if (!existsSync(path.join(repoPath, ".git"))) throw new ConfigError(`CHATLINK_REPO is not a git clone (no .git): ${repoPath}`);

  const stateDir = path.resolve(str(values.state) ?? str(env.CHATLINK_STATE_DIR) ?? defaultStateDir(me, repoPath, env));
  const indexFile = path.resolve(str(values.index) ?? str(env.CHATLINK_INDEX) ?? path.join(stateDir, "index.sqlite"));
  const model = str(values.model) ?? str(env.CHATLINK_MODEL_DIR);
  const modelDir = model === "none" ? null : path.resolve(model ?? DEFAULT_MODEL_DIR);
  return { me, repoPath, stateDir, indexFile, modelDir };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A warning when the clone is inside a file-sync folder: those tools can corrupt .git. */
export function syncFolderWarning(repoPath: string): string | null {
  // Split on both separators, so Windows and POSIX paths are judged the same on any OS.
  const parts = repoPath.split(/[\\/]+/);
  // Windows "OneDrive - Org", macOS "CloudStorage/OneDrive-Personal", "Dropbox (Personal)", iCloud, Google Drive.
  const hit = parts.find((p) =>
    /^(OneDrive([ -].*)?|Dropbox( \(.*\))?|iCloud ?Drive.*|iCloudDrive|Mobile Documents|CloudStorage|Google ?Drive.*|My Drive)$/i.test(p),
  );
  const m = hit ? [hit, hit] : null;
  return m
    ? `your clone is inside ${m[1]} (${repoPath}). File-sync tools can corrupt git folders: move the clone somewhere they don't sync, e.g. your home folder.`
    : null;
}
