import { type Event, makeEvent, monotonicUlid } from "../../src";

const T0 = Date.parse("2026-11-03T21:14:05.000Z");
const nextId = monotonicUlid();

/** One event of every known kind by `author`, at increasing times from `start`. */
export function oneOfEach(author: string, start = T0): Event[] {
  const at = (i: number) => ({ now: start + i * 1000, id: nextId(start + i * 1000) });
  const msg = makeEvent(author, { kind: "message", text: "Caching won't help here: every query has a unique timestamp in it." }, at(0));
  return [
    msg,
    makeEvent(author, { kind: "status", target: msg.id, status: "closed", reason: "caching idea rejected" }, at(1)),
    makeEvent(author, { kind: "note", text: "Remember: queries carry timestamps." }, at(2)),
    makeEvent(author, { kind: "assistant_note", text: "Summary: caching rejected.", about: msg.id }, at(3)),
    makeEvent(author, { kind: "import", text: "old chat line", role: "human", original_ts: "2026-10-01T10:00:00Z" }, at(4)),
  ];
}

export function messages(author: string, n: number, start = T0, text = (i: number) => `msg ${i}`): Event[] {
  return Array.from({ length: n }, (_, i) =>
    makeEvent(author, { kind: "message", text: text(i) }, { now: start + i * 1000, id: nextId(start + i * 1000) }),
  );
}

export const ids = (es: readonly Event[]) => es.map((e) => e.id).sort();
