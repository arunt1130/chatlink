/** Turns text into a fixed-size vector. Deterministic: same text, same bytes. */
export interface Embedder {
  /** Identifies the model (and its revision). A change makes the index re-embed. */
  readonly id: string;
  readonly dim: number;
  /** L2-normalized, or all zeros when the text has no known tokens. */
  embed(text: string): Float32Array;
}

/** Cosine similarity of two L2-normalized vectors (just the dot product). */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
