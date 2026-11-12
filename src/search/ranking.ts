/**
 * Every ranking knob lives here, so tuning means editing one object.
 *
 * score = keyword × recency
 *   keyword: FTS5 bm25, negated so higher is better (always > 0 for a match).
 *   recency: floor + (1 − floor) × 0.5^(age / halfLife), in (floor, 1].
 *
 * Multiplying (rather than adding) means two equally good keyword matches are
 * ordered by age, and a much better match still beats a slightly newer one.
 * Vector score and the confirmed boost join in M2b.
 */
export type RankingConfig = {
  /** Age at which an item's recency bonus has halved. */
  recencyHalfLifeDays: number;
  /** Share of its keyword score that even a very old item keeps. 0..1. */
  recencyFloor: number;
};

export const RANKING: Readonly<RankingConfig> = Object.freeze({
  recencyHalfLifeDays: 30,
  recencyFloor: 0.3,
});

const DAY_MS = 86_400_000;

/** In (floor, 1]. A future timestamp (clock skew) counts as age 0. */
export function recencyFactor(ageMs: number, cfg: RankingConfig = RANKING): number {
  const age = Math.max(0, ageMs);
  const floor = Math.min(1, Math.max(0, cfg.recencyFloor));
  const half = Math.max(1e-9, cfg.recencyHalfLifeDays) * DAY_MS;
  return floor + (1 - floor) * Math.pow(0.5, age / half);
}

export function combineScore(keyword: number, recency: number): number {
  return keyword * recency;
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
