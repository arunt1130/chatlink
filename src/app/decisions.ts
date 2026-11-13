import type { StatusValue } from "../events/schema";
import type { SearchHit } from "../search/sqliteIndex";

/**
 * A v1 heuristic: does this message look like it decides or closes something?
 * It only suggests. Claude asks the user in one line, and only a yes becomes
 * a status event (via mark_status).
 */
export type PossibleDecision = {
  status: Extract<StatusValue, "decided" | "closed">;
  /** The phrase that triggered it. */
  cue: string;
  /** The event id to mark if the user says yes. */
  target: string;
  /** What the target says, short, for the one-line question. */
  about: string;
  /** A ready-made one-line question for Claude to ask. */
  ask: string;
};

const CLOSED: RegExp[] = [
  /\blet'?s (not|drop|skip|abandon|kill|shelve)\b[^.!?\n]*/i,
  /\b(drop|scrap|shelve|kill|abandon)(ping|ped)? (the|this|that|it|our)\b[^.!?\n]*/i,
  /\b(not|never) (going to|gonna) (do|build|use|pursue)\b[^.!?\n]*/i,
  /\bwon'?t (do|build|use|pursue)\b[^.!?\n]*/i,
  /\b(rule[ds]? out|ruled out|rejected|no longer (needed|doing))\b[^.!?\n]*/i,
  /\b(close|closing) (this|it|that)( out)?\b[^.!?\n]*/i,
];
const DECIDED: RegExp[] = [
  /\b(we('ve| have)? decided|it'?s decided|decided (to|on))\b[^.!?\n]*/i,
  /\b(let'?s|we'?ll|we will|we are|we'?re) go(ing)? with\b[^.!?\n]*/i,
  /\b(settled on|agreed( on| to)?|final (answer|decision)|go ahead with|locked? in)\b[^.!?\n]*/i,
];

const short = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * @param messageId this message's event id, or null when it wasn't logged (share=false)
 * @param relevant this turn's search results, best first
 */
export function detectDecision(message: string, messageId: string | null, relevant: readonly SearchHit[], me?: string): PossibleDecision | null {
  const text = message.trim();
  if (!text) return null;
  // A question ("should we drop caching?") isn't a decision.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const statements = sentences.filter((s) => !s.trim().endsWith("?")).join(" ");
  if (!statements) return null;

  const find = (res: RegExp[]) => {
    for (const re of res) {
      const m = statements.match(re);
      if (m) return m[0].trim();
    }
    return null;
  };
  const closed = find(CLOSED);
  const decided = closed ? null : find(DECIDED);
  const cue = closed ?? decided;
  if (!cue) return null;
  const status = closed ? "closed" : "decided";

  // Closing usually refers to an earlier idea: prefer the best related item
  // that isn't a status event, isn't already marked that way, and isn't a
  // question. Someone else's statement beats my own earlier musing.
  const ok = (h: SearchHit) =>
    h.kind !== "status" && h.status?.status !== status && h.id !== messageId && !h.text.trim().endsWith("?") && h.match.keyword + h.match.vector > 0.3;
  const related = relevant.find((h) => ok(h) && h.author !== me) ?? relevant.find(ok);
  let target: string;
  let about: string;
  if (status === "closed" && related) {
    target = related.id;
    about = short(related.text);
  } else if (messageId) {
    target = messageId;
    about = short(text);
  } else if (related) {
    target = related.id;
    about = short(related.text);
  } else return null;
  return { status, cue: short(cue, 80), target, about, ask: `Mark "${about}" as ${status}?` };
}
