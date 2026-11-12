import { describe, expect, it } from "vitest";
import { dot, readEmbeddings, wordPieceFromJson } from "../../src";
import { realModel } from "../helpers/model";

const vocab = Object.fromEntries(["[PAD]", "[UNK]", "cach", "##ing", "caching", "won", "'", "t", "help", "cafe", "!", "東", "un", "##help", "##ful"].map((w, i) => [w, i]));
const tok = wordPieceFromJson({
  normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
  pre_tokenizer: { type: "BertPreTokenizer" },
  model: { type: "WordPiece", vocab, unk_token: "[UNK]", continuing_subword_prefix: "##", max_input_chars_per_word: 100 },
});

describe("M2b WordPiece tokenizer", () => {
  it("lowercases, strips accents, splits punctuation and CJK, greedy longest match", () => {
    expect(tok.tokenize("Caching WON'T help!")).toEqual(["caching", "won", "'", "t", "help", "!"]);
    expect(tok.tokenize("Café\u0000\t東unhelpful")).toEqual(["cafe", "東", "un", "##help", "##ful"]);
    expect(tok.tokenize("cachex")).toEqual(["[UNK]"]); // can't be fully covered → one [UNK]
    expect(tok.tokenize("x".repeat(101))).toEqual(["[UNK]"]);
  });

  it("refuses tokenizer files it doesn't understand", () => {
    expect(() => wordPieceFromJson({ model: { type: "BPE", vocab: {} } })).toThrow(/WordPiece/);
    expect(() => wordPieceFromJson({ normalizer: { type: "NFC" }, model: { type: "WordPiece", vocab } })).toThrow(/normalizer/);
  });
});

describe("M2b safetensors reader", () => {
  const make = (header: object, data: Buffer) => {
    const h = Buffer.from(JSON.stringify(header));
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(h.length));
    return Buffer.concat([len, h, data]);
  };
  it("reads a 2-D F32 tensor, even at an unaligned offset", () => {
    const data = Buffer.from(new Float32Array([1, 2, 3, 4, 5, 6]).buffer);
    const buf = make({ embeddings: { dtype: "F32", shape: [3, 2], data_offsets: [0, 24] }, x: "y" }, data);
    const { table, dim } = readEmbeddings(buf);
    expect(dim).toBe(2);
    expect([...table]).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("rejects wrong dtype, shape, size, or a short file", () => {
    const d = Buffer.alloc(24);
    expect(() => readEmbeddings(Buffer.alloc(4))).toThrow();
    expect(() => readEmbeddings(make({ embeddings: { dtype: "F16", shape: [3, 2], data_offsets: [0, 24] } }, d))).toThrow(/F32/);
    expect(() => readEmbeddings(make({ embeddings: { dtype: "F32", shape: [4, 2], data_offsets: [0, 24] } }, d))).toThrow(/size/);
    expect(() => readEmbeddings(make({ other: {} }, d))).toThrow(/embeddings/);
  });
});

describe("M2b potion-base-32M embedder", () => {
  it("is deterministic, normalized, and zero for text with no known tokens", () => {
    const m = realModel();
    expect(m.dim).toBe(512);
    expect(m.id).toMatch(/^model2vec:minishlab\/potion-base-32M@[0-9a-f]{40}$/);
    const a = m.embed("Caching won't help here.");
    expect(Buffer.from(a.buffer)).toEqual(Buffer.from(m.embed("Caching won't help here.").buffer));
    expect(dot(a, a)).toBeCloseTo(1, 5);
    expect([...m.embed("")].every((x) => x === 0)).toBe(true);
  });

  it("puts related words closer than unrelated ones", () => {
    const m = realModel();
    const sim = (x: string, y: string) => dot(m.embed(x), m.embed(y));
    expect(sim("cache", "caching")).toBeGreaterThan(sim("cache", "lunch"));
    expect(sim("database", "postgres")).toBeGreaterThan(sim("database", "friday"));
  });
});
