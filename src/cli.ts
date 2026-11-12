import path from "node:path";
import { parseArgs } from "node:util";
import { GitTransport } from "./transport/git";
import { SqliteIndex } from "./search/sqliteIndex";
import { rebuildIndex } from "./search/sync";

const USAGE = `usage:
  chatlink rebuild --repo <clone> --me <name> --state <dir> [--index <file>]
      Delete the local index and rebuild it from the logs.
  chatlink search  --repo <clone> --state <dir> [--index <file>] [--author <name>] [--since <iso>] [--limit <n>] <query...>
      Search the local index (no sync).`;

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
    },
  });
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    if (typeof v !== "string" || v === "") throw new UsageError(`missing --${k}`);
    return v;
  };
  const indexFile = () => values.index ?? path.join(need("state"), "index.sqlite");

  switch (cmd) {
    case "rebuild": {
      const transport = new GitTransport({ me: need("me"), repoPath: need("repo"), stateDir: need("state"), env: deps.env });
      const r = await rebuildIndex(indexFile(), transport, { source: need("repo") });
      const size = r.index.size;
      r.index.close();
      await transport.whenIdle();
      console.log(JSON.stringify({ indexed: size, skipped: r.skipped.length, sync: r.sync }, null, 2));
      return 0;
    }
    case "search": {
      const index = SqliteIndex.open(indexFile(), { source: need("repo") });
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
