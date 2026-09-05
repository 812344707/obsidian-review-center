import { describe, expect, it, vi } from "vitest";
import { ParseCache, sha256Text, type ParseCacheBackend, type ParseCacheEntry } from "../src/parse-cache";

function memoryBackend(): ParseCacheBackend {
  const entries = new Map<string, ParseCacheEntry>();
  return {
    get: async (key) => structuredClone(entries.get(key)),
    put: async (entry) => { entries.set(entry.key, structuredClone(entry)); },
    delete: async (key) => { entries.delete(key); },
  };
}

const parsed = (answer: string) => ({
  found: true,
  valid: true,
  warnings: [],
  cards: [{
    kind: "qa" as const,
    hash: answer,
    content: { question: "问题", answer, raw: answer, sourceStartLine: 0, sourceEndLine: 1 },
    insertIdAfterLine: 1,
  }],
});

describe("local parse cache", () => {
  it("uses SHA-256 over normalized full text", async () => {
    expect(await sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Text("a\r\nb")).toBe(await sha256Text("a\nb"));
  });

  it("reuses only identical text, parser version and recognition settings", async () => {
    const backend = memoryBackend();
    const cache = new ParseCache(() => "vault-a", async () => backend);
    const parse = vi.fn(() => parsed("答案"));
    expect((await cache.getOrParse("source", "正文", 2, "rules-a", parse)).hit).toBe(false);
    expect((await cache.getOrParse("source", "正文", 2, "rules-a", parse)).hit).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
    expect((await cache.getOrParse("source", "修改", 2, "rules-a", parse)).hit).toBe(false);
    expect((await cache.getOrParse("source", "修改", 3, "rules-a", parse)).hit).toBe(false);
    expect((await cache.getOrParse("source", "修改", 3, "rules-b", parse)).hit).toBe(false);
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it("isolates vaults, deletes removed sources and falls back if the cache fails", async () => {
    const backend = memoryBackend();
    const first = new ParseCache(() => "vault-a", async () => backend);
    const other = new ParseCache(() => "vault-b", async () => backend);
    const parseA = vi.fn(() => parsed("A")), parseB = vi.fn(() => parsed("B"));
    await first.getOrParse("same", "正文", 2, "rules", parseA);
    expect((await other.getOrParse("same", "正文", 2, "rules", parseB)).result.cards[0].content.answer).toBe("B");
    await first.delete("same");
    expect((await first.getOrParse("same", "正文", 2, "rules", parseA)).hit).toBe(false);

    const broken = new ParseCache(() => "vault-a", async () => ({
      get: async () => { throw new Error("damaged"); }, put: async () => undefined, delete: async () => undefined,
    }));
    expect((await broken.getOrParse("source", "正文", 2, "rules", () => parsed("fallback"))).result.cards[0].content.answer)
      .toBe("fallback");
  });
});
