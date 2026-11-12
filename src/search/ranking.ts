import type { StatusValue, Tier } from "../events/schema";

/**
 * Every ranking knob lives here, so tuning means editing one object.
 *
 * relevance = keywordWeight × keyword + vectorWeight × vector
 *   keyword: idf-weighted share of the query's (non-stopword) terms the item
 *            contains × (0.5 + 0.5 × bm25 / best bm25 in this query), in [0, 1].
 *            Absolute, so a hit on one common word can't score a perfect 1.
 *   vector:  cosine similarity to the query, 0 below `minVectorSim`, in [0, 1].
 * score = relevance × recency × tierBoost[tier] × statusBoost[status]
 *   recency: floor + (1 − floor) × 0.5^(age / halfLife), in (floor, 1].
 *   statusBoost applies to an item someone marked (its latest status).
 *
 * Multiplying recency in (rather than adding it) means two equally good
 * matches are ordered by age, and a much better match still beats a slightly
 * newer one. Without an embedder, `vector` is 0 for everything and ranking is
 * keyword × recency × boosts.
 */
export type RankingConfig = {
  keywordWeight: number;
  vectorWeight: number;
  /** Vector matches below this similarity are ignored (unrelated text scores ~0–0.25 with potion-base-32M). */
  minVectorSim: number;
  /** How many candidates each of keyword and vector search contributes before final ranking. */
  candidatePool: number;
  /** Age at which an item's recency bonus has halved. */
  recencyHalfLifeDays: number;
  /** Share of its score that even a very old item keeps. 0..1. */
  recencyFloor: number;
  /** Trust tiers: confirmed items rank above plain messages, model-written ones below. */
  tierBoost: Record<Tier | "unknown", number>;
  /** An item a person marked: the latest status's value. */
  statusBoost: Record<StatusValue, number>;
};

export const RANKING: Readonly<RankingConfig> = Object.freeze({
  keywordWeight: 0.5,
  vectorWeight: 0.5,
  minVectorSim: 0.25,
  candidatePool: 200,
  recencyHalfLifeDays: 30,
  recencyFloor: 0.3,
  tierBoost: Object.freeze({ confirmed: 1.25, said: 1, imported: 0.9, "model-written": 0.75, unknown: 0.75 }),
  statusBoost: Object.freeze({ decided: 1.25, closed: 1.25, superseded: 1.1, reopened: 1 }),
});

const DAY_MS = 86_400_000;

/** In (floor, 1]. A future timestamp (clock skew) counts as age 0. */
export function recencyFactor(ageMs: number, cfg: Pick<RankingConfig, "recencyFloor" | "recencyHalfLifeDays"> = RANKING): number {
  const age = Math.max(0, ageMs);
  const floor = Math.min(1, Math.max(0, cfg.recencyFloor));
  const half = Math.max(1e-9, cfg.recencyHalfLifeDays) * DAY_MS;
  return floor + (1 - floor) * Math.pow(0.5, age / half);
}

export type ScoreInput = { keyword: number; vector: number; ageMs: number; tier: Tier | null; status: StatusValue | null };

export function scoreOf(x: ScoreInput, cfg: RankingConfig = RANKING): number {
  const relevance = cfg.keywordWeight * x.keyword + cfg.vectorWeight * x.vector;
  const tier = cfg.tierBoost[x.tier ?? "unknown"] ?? 1;
  const status = x.status ? (cfg.statusBoost[x.status] ?? 1) : 1;
  return relevance * recencyFactor(x.ageMs, cfg) * tier * status;
}

/** Merges a partial override (including nested boost tables) onto the defaults. */
export function rankingWith(o: Partial<RankingConfig> = {}): RankingConfig {
  return {
    ...RANKING,
    ...o,
    tierBoost: { ...RANKING.tierBoost, ...o.tierBoost },
    statusBoost: { ...RANKING.statusBoost, ...o.statusBoost },
  };
}

/** Search defaults that aren't ranking weights. */
export const SEARCH_DEFAULTS = Object.freeze({
  limit: 10,
  maxLimit: 100,
  /** Longer texts are cut to this many characters (the hit says so; fetch the rest by id). */
  maxTextChars: 1000,
  /** Query words beyond this are ignored. */
  maxQueryTerms: 32,
});
