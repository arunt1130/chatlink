import "./tmp"; // registered first, so its afterEach (removing temp dirs) runs after apps close
import path from "node:path";
import { afterEach } from "vitest";
import { Chatlink, type ChatlinkConfig, type Embedder } from "../../src";
import type { Space } from "./gitFixture";

const open: Chatlink[] = [];

export function appConfig(s: Space, me: string, extra: Partial<ChatlinkConfig> = {}): ChatlinkConfig {
  const stateDir = s.stateDir(me);
  return { me, repoPath: s.clone(me), stateDir, indexFile: path.join(stateDir, "index.sqlite"), modelDir: null, gitEnv: s.env, ...extra };
}

/** A Chatlink for `me` on its clone in `s`; closed after the test. */
export function openApp(s: Space, me: string, opts: { embedder?: Embedder | null; now?: () => number; cfg?: Partial<ChatlinkConfig> } = {}): Chatlink {
  const app = Chatlink.open(appConfig(s, me, opts.cfg), { embedder: opts.embedder ?? null, now: opts.now });
  open.push(app);
  return app;
}

/** Closes an app now (e.g. to simulate a restart); it won't be closed again. */
export async function closeApp(app: Chatlink): Promise<void> {
  const i = open.indexOf(app);
  if (i >= 0) open.splice(i, 1);
  await app.close();
}

afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
});
