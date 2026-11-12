import { existsSync } from "node:fs";
import path from "node:path";
import { type Embedder, Model2Vec } from "../../src";

export const MODEL_DIR = path.resolve(__dirname, "..", "..", "models", "potion-base-32M");

let cached: Model2Vec | undefined;

/**
 * The real embedding model, loaded once per test file. Tests never download it:
 * a missing model is a loud failure, not a skip, so the acceptance test can't
 * silently stop running.
 */
export function realModel(): Model2Vec {
  if (!cached) {
    if (!existsSync(path.join(MODEL_DIR, "model.safetensors"))) {
      throw new Error(`embedding model missing at ${MODEL_DIR}. Run once (needs network): node scripts/fetch-model.mjs`);
    }
    cached = Model2Vec.load(MODEL_DIR);
  }
  return cached;
}

/** A tiny deterministic bag-of-words embedder for logic tests (not semantic). */
export function bagEmbedder(id = "bag:v1", dim = 64): Embedder & { calls: number } {
  const e = {
    id,
    dim,
    calls: 0,
    embed(text: string): Float32Array {
      e.calls++;
      const v = new Float32Array(dim);
      for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        v[(h >>> 0) % dim]! += 1;
      }
      const n = Math.hypot(...v);
      if (n > 0) for (let i = 0; i < dim; i++) v[i]! /= n;
      return v;
    },
  };
  return e;
}
