import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Embedder, SqliteIndex, makeEvent, readEmbeddings } from "../../src";
import { main } from "../../src/cli";
import { makeSpace } from "../helpers/gitFixture";
import { openIndex } from "../helpers/index";
import { MODEL_DIR, realModel } from "../helpers/model";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const msg = (author: string, text: string) => makeEvent(author, { kind: "message", text }, { now: NOW - 86_400_000 });

describe("M2b query edge cases", () => {
  it("a query of only stopwords still keyword-matches", () => {
    const idx = openIndex(undefined, { embedder: realModel() });
    const e = msg("arun", "We should, shouldn't we?");
    idx.ingest([e, msg("krish", "Postgres it is.")]);
    const hits = idx.search("should we", { now: NOW });
    expect(hits[0]?.id).toBe(e.id);
    expect(hits[0]!.match.keyword).toBeGreaterThan(0);
  });

  it("a query the embedder can't represent falls back to keyword results", () => {
    const zero: Embedder = { id: "zero", dim: 4, embed: (t) => (t.includes("zzqx") ? new Float32Array(4) : new Float32Array([1, 0, 0, 0])) };
    const idx = openIndex(undefined, { embedder: zero });
    const e = msg("arun", "the zzqx incident");
    idx.ingest([e, msg("krish", "something else")]);
    const hits = idx.search("zzqx", { now: NOW });
    expect(hits.map((h) => h.id)).toEqual([e.id]);
    expect(hits[0]!.match.vector).toBe(0);
  });
});

describe("M2b safetensors at a misaligned data offset", () => {
  it("copies the tensor correctly when 8 + header length is not a multiple of 4", () => {
    const data = Buffer.from(new Float32Array([1.5, -2, 3.25, 4]).buffer);
    for (let pad = 0; pad < 4; pad++) {
      const h = Buffer.from(JSON.stringify({ embeddings: { dtype: "F32", shape: [2, 2], data_offsets: [0, 16] }, p: "x".repeat(pad) }));
      const len = Buffer.alloc(8);
      len.writeBigUInt64LE(BigInt(h.length));
      const { table } = readEmbeddings(Buffer.concat([len, h, data]));
      expect([...table]).toEqual([1.5, -2, 3.25, 4]);
    }
  });
});

describe("M2b CLI model options", { timeout: 60_000 }, () => {
  it("--model enables vector search; --no-model is keyword-only", async () => {
    const s = makeSpace();
    const krish = s.transport("krish");
    const k = msg("krish", "Caching won't help here: every query has a unique timestamp in it.");
    await krish.appendMine([k]);
    await krish.whenIdle();
    const base = ["--repo", s.clone("arun"), "--state", s.stateDir("arun")];
    const run = async (args: string[]) => {
      const out: string[] = [];
      const orig = console.log;
      console.log = (x: string) => out.push(x);
      try {
        expect(await main(args, { env: s.env })).toBe(0);
      } finally {
        console.log = orig;
      }
      return JSON.parse(out[0]!);
    };
    await run(["rebuild", ...base, "--me", "arun", "--model", MODEL_DIR]);
    const q = ["store", "responses", "so", "repeat", "requests", "are", "faster"];
    const withModel = await run(["search", ...base, "--model", MODEL_DIR, ...q]);
    expect(withModel.map((h: { id: string }) => h.id)).toEqual([k.id]);
    const without = await run(["search", ...base, "--no-model", ...q]);
    expect(without).toEqual([]);
    const idx = SqliteIndex.open(path.join(s.stateDir("arun"), "index.sqlite"));
    expect(idx.getMeta("embedder")).toBe(realModel().id);
    idx.close();
  });
});
