import { describe, expect, it } from "vitest";
import { applyRating } from "../src/scheduler";
import { getQueueCounts, prepareDailyQueue, buildDailyQueue } from "../src/queue";
import { parseReviewCards, renderCloze } from "../src/parser";
import { ParseCache, type ParseCacheBackend, type ParseCacheEntry } from "../src/parse-cache";
import { fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";

function elapsed(operation: () => void): number {
  const started = performance.now();
  operation();
  return performance.now() - started;
}

describe("1,000-source scale fixture", () => {
  it("compares shared home preparation, start, reveal, grade and cached organization", async () => {
    const settings = fixtureSettings();
    settings.cardGroups[0].parameters.newLimit = 20_000;
    settings.cardGroups[0].parameters.reviewLimit = 20_000;
    settings.cardGroups[0].nodes = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`card/t${i}`, {}]));
    const records = Array.from({ length: 1_000 }, (_, i) => fixtureRecord(`source-${i}`, [`#card/t${i % 100}`]));
    const history = Array.from({ length: 10_000 }, (_, i) => reviewEvent(`history-${i}`, `source-${i % 1_000}`));
    const paths = Array.from({ length: 100 }, (_, i) => `card/t${i}`);

    // Warm JIT paths before recording the comparison.
    getQueueCounts(records, history, settings, "card", today, undefined, paths[0]);
    const uncachedCounts: unknown[] = [];
    const homeBeforeMs = elapsed(() => {
      for (const path of paths) uncachedCounts.push(getQueueCounts(records, history, settings, "card", today, undefined, path));
    });
    const sharedCounts: unknown[] = [];
    const homeAfterMs = elapsed(() => {
      const prepared = prepareDailyQueue(records, history, settings, "card", today);
      for (const path of paths) sharedCounts.push(getQueueCounts(records, history, settings, "card", today, undefined, path, prepared));
    });
    expect(sharedCounts).toEqual(uncachedCounts);

    let queueLength = 0;
    const startMs = elapsed(() => { queueLength = buildDailyQueue(records, history, settings, "card", today).length; });
    expect(queueLength).toBeGreaterThan(0);
    const cloze = "经文 {{c1::答案::提示}}，同号 {{c1::同时显示}}，另有 {{c2::其他答案}}。";
    const revealMs = elapsed(() => { for (let i = 0; i < 10_000; i += 1) renderCloze(cloze, 1, i % 2 === 0); });
    const gradeMs = elapsed(() => {
      const item = records[0].cards["rv-one:qa"];
      for (let i = 0; i < 1_000; i += 1) applyRating(item, 3, settings.cardGroups[0].parameters);
    });

    const entries = new Map<string, ParseCacheEntry>();
    const backend: ParseCacheBackend = {
      get: async (key) => structuredClone(entries.get(key)),
      put: async (entry) => { entries.set(entry.key, structuredClone(entry)); },
      delete: async (key) => { entries.delete(key); },
    };
    const cache = new ParseCache(() => "scale-vault", async () => backend);
    const sources = Array.from({ length: 1_000 }, (_, i) =>
      `# 材料 ${i}\n\nQ: 问题 ${i}\nA: 答案 ${i}\n\n段落 ${"正文".repeat(30)} {{c1::重点 ${i}}}。`);
    let parses = 0;
    const organize = async () => {
      for (let i = 0; i < sources.length; i += 1) {
        const markdown = sources[i];
        await cache.getOrParse(`source-${i}`, markdown, 2, "same-rules", () => { parses += 1; return parseReviewCards(markdown); });
      }
    };
    let started = performance.now(); await organize(); const organizeColdMs = performance.now() - started;
    expect(parses).toBe(1_000);
    started = performance.now(); await organize(); const organizeWarmMs = performance.now() - started;
    expect(parses).toBe(1_000);
    sources[317] += "\n";
    await organize();
    expect(parses).toBe(1_001);

    console.info("[scale-performance]", JSON.stringify({
      fixture: { sources: 1_000, tagNodes: 100, history: 10_000 },
      milliseconds: {
        organizeCold: Number(organizeColdMs.toFixed(1)), organizeWarm: Number(organizeWarmMs.toFixed(1)),
        homeWithoutSharedPreparation: Number(homeBeforeMs.toFixed(1)), homeWithSharedPreparation: Number(homeAfterMs.toFixed(1)),
        startQueue: Number(startMs.toFixed(1)), reveal10k: Number(revealMs.toFixed(1)), grade1k: Number(gradeMs.toFixed(1)),
      },
    }));
  }, 20_000);
});
