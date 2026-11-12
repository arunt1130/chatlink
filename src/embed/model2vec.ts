import { readFileSync } from "node:fs";
import path from "node:path";
import type { Embedder } from "./types";
import { type WordPiece, wordPieceFromJson } from "./wordpiece";

/**
 * A model2vec static embedding model, in pure JS: tokenize, look up one row
 * per token, mean-pool, L2-normalize. Mirrors model2vec's StaticModel.encode
 * (no special tokens, [UNK] dropped, at most `maxTokens` tokens).
 */
export class Model2Vec implements Embedder {
  readonly id: string;
  readonly dim: number;
  private readonly rows: number;

  private constructor(
    id: string,
    private readonly tokenizer: WordPiece,
    private readonly table: Float32Array,
    dim: number,
    private readonly normalize: boolean,
    private readonly maxTokens: number,
  ) {
    this.id = id;
    this.dim = dim;
    this.rows = table.length / dim;
  }

  /** Loads model.safetensors, tokenizer.json and config.json from `dir`. */
  static load(dir: string, opts: { maxTokens?: number } = {}): Model2Vec {
    const read = (f: string) => readFileSync(path.join(dir, f));
    let config: { normalize?: boolean } = {};
    try {
      config = JSON.parse(read("config.json").toString("utf8"));
    } catch {
      /* optional */
    }
    let source = "";
    try {
      const s = JSON.parse(read("SOURCE.json").toString("utf8")) as { repo?: string; revision?: string };
      source = `${s.repo}@${s.revision}`;
    } catch {
      source = path.basename(path.resolve(dir));
    }
    const tokenizer = wordPieceFromJson(JSON.parse(read("tokenizer.json").toString("utf8")));
    const { table, dim } = readEmbeddings(read("model.safetensors"));
    return new Model2Vec(`model2vec:${source}`, tokenizer, table, dim, config.normalize ?? true, opts.maxTokens ?? 512);
  }

  tokenIds(text: string): number[] {
    const unk = this.tokenizer.unkId;
    return this.tokenizer.encode(text).filter((id) => id !== unk && id < this.rows).slice(0, this.maxTokens);
  }

  embed(text: string): Float32Array {
    const out = new Float32Array(this.dim);
    const ids = this.tokenIds(text);
    if (ids.length === 0) return out;
    for (const id of ids) {
      const off = id * this.dim;
      for (let j = 0; j < this.dim; j++) out[j]! += this.table[off + j]!;
    }
    for (let j = 0; j < this.dim; j++) out[j]! /= ids.length;
    if (this.normalize) {
      let n = 0;
      for (let j = 0; j < this.dim; j++) n += out[j]! * out[j]!;
      n = Math.sqrt(n);
      if (n > 0) for (let j = 0; j < this.dim; j++) out[j]! /= n;
    }
    return out;
  }
}

/** Reads the single 2-D F32 tensor `embeddings` from a safetensors file. */
export function readEmbeddings(buf: Buffer): { table: Float32Array; dim: number } {
  if (buf.length < 8) throw new Error("safetensors: file too short");
  const n = Number(buf.readBigUInt64LE(0));
  if (n <= 0 || 8 + n > buf.length) throw new Error("safetensors: bad header length");
  const header = JSON.parse(buf.subarray(8, 8 + n).toString("utf8")) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const t = header.embeddings;
  if (!t) throw new Error("safetensors: no 'embeddings' tensor");
  if (t.dtype !== "F32" || t.shape.length !== 2) throw new Error(`safetensors: expected 2-D F32, got ${t.dtype} ${JSON.stringify(t.shape)}`);
  const [rows, dim] = t.shape as [number, number];
  const [a, b] = t.data_offsets;
  if (b - a !== rows * dim * 4 || 8 + n + b > buf.length) throw new Error("safetensors: data size mismatch");
  // Copy into an aligned buffer (the data offset need not be 4-byte aligned).
  const bytes = buf.subarray(8 + n + a, 8 + n + b);
  const table = new Float32Array(rows * dim);
  new Uint8Array(table.buffer).set(bytes);
  return { table, dim };
}
