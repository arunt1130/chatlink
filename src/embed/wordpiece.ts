/**
 * A BERT WordPiece tokenizer, enough to read a Hugging Face tokenizer.json of
 * the form BertNormalizer + BertPreTokenizer + WordPiece (what model2vec's
 * potion models ship). No special tokens are added: model2vec encodes without them.
 */
export type WordPieceConfig = {
  vocab: Map<string, number>;
  unkToken: string;
  prefix: string;
  maxCharsPerWord: number;
  lowercase: boolean;
  stripAccents: boolean;
  cleanText: boolean;
  handleChineseChars: boolean;
};

type TokenizerJson = {
  normalizer?: { type?: string; clean_text?: boolean; handle_chinese_chars?: boolean; strip_accents?: boolean | null; lowercase?: boolean } | null;
  pre_tokenizer?: { type?: string } | null;
  model?: { type?: string; vocab?: Record<string, number>; unk_token?: string; continuing_subword_prefix?: string; max_input_chars_per_word?: number };
};

export function wordPieceFromJson(json: unknown): WordPiece {
  const t = json as TokenizerJson;
  const m = t.model;
  if (m?.type !== "WordPiece" || !m.vocab) throw new Error("tokenizer.json: expected a WordPiece model");
  if (t.normalizer && t.normalizer.type !== "BertNormalizer") throw new Error(`tokenizer.json: unsupported normalizer ${t.normalizer.type}`);
  if (t.pre_tokenizer && t.pre_tokenizer.type !== "BertPreTokenizer") throw new Error(`tokenizer.json: unsupported pre_tokenizer ${t.pre_tokenizer.type}`);
  const n = t.normalizer ?? {};
  const lowercase = n.lowercase ?? true;
  return new WordPiece({
    vocab: new Map(Object.entries(m.vocab)),
    unkToken: m.unk_token ?? "[UNK]",
    prefix: m.continuing_subword_prefix ?? "##",
    maxCharsPerWord: m.max_input_chars_per_word ?? 100,
    lowercase,
    // Hugging Face: strip_accents null means "follow lowercase".
    stripAccents: n.strip_accents ?? lowercase,
    cleanText: n.clean_text ?? true,
    handleChineseChars: n.handle_chinese_chars ?? true,
  });
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const WHITESPACE = /[\t\n\r\p{Zs}]/u;
const PUNCT = /[!-/:-@[-`{-~]|\p{P}/u;
const MARK = /\p{Mn}/gu;

function isChinese(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

export class WordPiece {
  readonly unkId: number | undefined;

  constructor(private readonly cfg: WordPieceConfig) {
    this.unkId = cfg.vocab.get(cfg.unkToken);
  }

  normalize(text: string): string {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (this.cfg.cleanText) {
        if (cp === 0 || cp === 0xfffd) continue;
        if (WHITESPACE.test(ch)) {
          out += " ";
          continue;
        }
        if (CONTROL.test(ch)) continue;
      }
      out += this.cfg.handleChineseChars && isChinese(cp) ? ` ${ch} ` : ch;
    }
    if (this.cfg.stripAccents) out = out.normalize("NFD").replace(MARK, "");
    if (this.cfg.lowercase) out = out.toLowerCase();
    return out;
  }

  /** Splits on whitespace and isolates each punctuation character. */
  preTokenize(text: string): string[] {
    const words: string[] = [];
    let cur = "";
    for (const ch of text) {
      if (/\s/u.test(ch)) {
        if (cur) words.push(cur);
        cur = "";
      } else if (PUNCT.test(ch)) {
        if (cur) words.push(cur);
        words.push(ch);
        cur = "";
      } else cur += ch;
    }
    if (cur) words.push(cur);
    return words;
  }

  /** Greedy longest-match-first. A word that can't be fully covered becomes one [UNK]. */
  wordPiece(word: string): string[] {
    const chars = Array.from(word);
    if (chars.length > this.cfg.maxCharsPerWord) return [this.cfg.unkToken];
    const out: string[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: string | null = null;
      while (start < end) {
        const sub = (start > 0 ? this.cfg.prefix : "") + chars.slice(start, end).join("");
        if (this.cfg.vocab.has(sub)) {
          found = sub;
          break;
        }
        end--;
      }
      if (found === null) return [this.cfg.unkToken];
      out.push(found);
      start = end;
    }
    return out;
  }

  tokenize(text: string): string[] {
    return this.preTokenize(this.normalize(text)).flatMap((w) => this.wordPiece(w));
  }

  encode(text: string): number[] {
    return this.tokenize(text).map((t) => this.cfg.vocab.get(t) ?? this.unkId ?? -1).filter((id) => id >= 0);
  }
}
