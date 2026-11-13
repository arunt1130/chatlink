import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL_DIR } from "./config";
import { Model2Vec } from "./embed/model2vec";
import type { Embedder } from "./embed/types";
import { GitTransport } from "./transport/git";
import { SqliteIndex } from "./search/sqliteIndex";
import { rebuildIndex } from "./search/sync";

const USAGE = `usage:
  chatlink rebuild --repo <clone> --me <name> --state <dir> [--index <file>] [--model <dir> | --no-model]
      Delete the local index and rebuild it from the logs.
  chatlink search  --repo <clone> --state <dir> [--index <file>] [--author <name>] [--since <iso>] [--limit <n>] [--model <dir> | --no-model] <query...>
      Search the local index (no sync).
  --model defaults to models/potion-base-32M next to the program (fetch it with scripts/fetch-model.mjs).
  Without a model, search is keyword-only.`;

export { DEFAULT_MODEL_DIR };

export async function main(argv: string[], deps: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      me: { type: "string" },
      state: { type: "string" },
      index: { type: "string" },
      author: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
      model: { type: "string" },
      "no-model": { type: "boolean" },
    },
  });
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    if (typeof v !== "string" || v === "") throw new UsageError(`missing --${k}`);
    return v;
  };
  const indexFile = () => values.index ?? path.join(need("state"), "index.sqlite");
  const embedder = (): Embedder | undefined => {
    if (values["no-model"]) return undefined;
    const dir = values.model ?? DEFAULT_MODEL_DIR;
    if (values.model === undefined && !existsSync(path.join(dir, "model.safetensors"))) {
      console.error(`no embedding model at ${dir}; keyword-only`);
      return undefined;
    }
    return Model2Vec.load(dir);
  };

  switch (cmd) {
    case "rebuild": {
      const transport = new GitTransport({ me: need("me"), repoPath: need("repo"), stateDir: need("state"), env: deps.env });
      const r = await rebuildIndex(indexFile(), transport, { source: need("repo"), embedder: embedder() });
      const size = r.index.size;
      r.index.close();
      await transport.whenIdle();
      console.log(JSON.stringify({ indexed: size, skipped: r.skipped.length, sync: r.sync }, null, 2));
      return 0;
    }
    case "search": {
      const index = SqliteIndex.open(indexFile(), { source: need("repo"), embedder: embedder() });
      try {
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        const hits = index.search(positionals.join(" "), { author: values.author, since: values.since, limit });
        console.log(JSON.stringify(hits, null, 2));
      } finally {
        index.close();
      }
      return 0;
    }
    default:
      throw new UsageError(cmd ? `unknown command: ${cmd}` : "no command");
  }
}

class UsageError extends Error {}

const isEntry = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof UsageError ? `${e.message}\n${USAGE}` : String((e as Error)?.stack ?? e));
      process.exit(e instanceof UsageError ? 2 : 1);
    },
  );
}
