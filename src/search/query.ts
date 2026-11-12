import { SEARCH_DEFAULTS } from "./ranking";

/**
 * Common English words left out of the keyword part of a query (documents are
 * still indexed in full). Without this, a match on "the" or "we" counts as
 * much as a match on "caching". The vector part always sees the whole query.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers herself him
  himself his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or
  other our ours ourselves out over own same she should so some such than that the their theirs them themselves then
  there these they this those through to too under until up very was we were what when where which while who whom why
  will with would you your yours yourself yourselves s t d ll m re ve y won don doesn didn isn aren wasn weren hasn haven
  hadn shouldn wouldn couldn can't let's also may might must shall going get got`
    .split(/\s+/)
    .filter(Boolean),
);

/** The query's distinct words (letters/digits, lowercased), stopwords removed unless that leaves nothing. */
export function queryTerms(query: string, maxTerms: number = SEARCH_DEFAULTS.maxQueryTerms): string[] {
  const words = [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const content = words.filter((w) => !STOPWORDS.has(w));
  return (content.length ? content : words).slice(0, maxTerms);
}

/** Turns free text into an FTS5 query: each word quoted, OR-ed. Never passes FTS syntax through. */
export function toFtsQuery(query: string, maxTerms: number = SEARCH_DEFAULTS.maxQueryTerms): string | null {
  const terms = queryTerms(query, maxTerms);
  return terms.length ? terms.map((w) => `"${w}"`).join(" OR ") : null;
}
