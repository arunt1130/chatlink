import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Local-only sync bookkeeping. Lives in the state dir, never in the repo. */
export type PersistedState = { lastPullAt: string | null; lastPushAt: string | null; lastError: string | null };

const FILE = "sync-state.json";
const EMPTY: PersistedState = { lastPullAt: null, lastPushAt: null, lastError: null };

export function loadState(stateDir: string): PersistedState {
  try {
    const o = JSON.parse(readFileSync(path.join(stateDir, FILE), "utf8")) as Partial<PersistedState>;
    return {
      lastPullAt: typeof o.lastPullAt === "string" ? o.lastPullAt : null,
      lastPushAt: typeof o.lastPushAt === "string" ? o.lastPushAt : null,
      lastError: typeof o.lastError === "string" ? o.lastError : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveState(stateDir: string, s: PersistedState): void {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, file);
}
