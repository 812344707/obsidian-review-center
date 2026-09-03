import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (value: string) => value,
  getAllTags: (cache: { tags?: Array<{tag: string}>; frontmatter?: {tags?: string[]} }) =>
    [...(cache.tags ?? []).map((tag) => tag.tag), ...(cache.frontmatter?.tags ?? []).map((tag) => `#${tag}`)] }));
import type { App } from "obsidian";
import { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import type { HistoryEvent, SourceRecord } from "../src/types";
import { fixtureSettings } from "./fixtures";
import { collectEntries } from "../src/queue";

function harness(tags = ["note", "card"]) {
  const settings = fixtureSettings();
  type File = { path: string; basename: string; stat: { ctime: number }; content: string; cache: Record<string, unknown> | null };
  const file: File = { path: "资料/测试.md", basename: "测试", stat: { ctime: Date.now() }, content: "## 复习\n\n问:: 问题\n答:: 答案\n", cache: { frontmatter: { tags } } };
  const files: File[] = [file];
  const records = new Map<string, SourceRecord>(); const history: HistoryEvent[] = [];
  const app = {
    vault: { getMarkdownFiles: () => files, read: async (file: File) => file.content,
      process: vi.fn(async (file: File, fn: (text: string) => string) => { file.content = fn(file.content); }) },
    metadataCache: { getFileCache: (file: File) => file.cache },
    fileManager: { processFrontMatter: vi.fn(async (file: File, fn: (value: object) => void) => fn(file.cache!.frontmatter as object)) },
  };
  const store = { sessionId: "s", deviceId: "d", initialize: async () => undefined,
    loadAllHistory: async () => structuredClone(history), loadAllRecords: async () => structuredClone([...records.values()]),
    saveRecord: async (record: SourceRecord) => { records.set(record.reviewId, structuredClone(record)); },
    appendHistory: async (events: HistoryEvent[]) => { history.push(...structuredClone(events)); },
    deleteRecord: async (id: string) => { records.delete(id); } };
  const scanner = new VaultScanner(app as unknown as App, store as unknown as ReviewStore, () => settings);
  return { scanner, settings, app, records, history, file, files };
}

describe("tag scanner identity and scope", () => {
  it("reads property and inline tags and only parses cards when their scope matches", async () => {
    const h = harness(["note"]);
    let result = await h.scanner.scan();
    expect(result.records).toHaveLength(1);
    expect(Object.values(result.records[0].cards)).toHaveLength(0);
    expect(h.app.vault.process).not.toHaveBeenCalled();
    h.file.cache!.tags = [{ tag: "#CARD/inline" }];
    result = await h.scanner.scan();
    expect(Object.values(result.records[0].cards)).toHaveLength(1);
    expect(collectEntries(result.records, "card", h.settings)).toHaveLength(1);
  });
  it("preserves identities and schedules through rename, tag removal and re-entry", async () => {
    const h = harness();
    let result = await h.scanner.scan();
    const original = structuredClone(result.records[0]);
    h.file.path = "另一个文件夹/改名.md"; h.file.basename = "改名";
    result = await h.scanner.scan();
    expect(result.records[0].reviewId).toBe(original.reviewId);
    expect(result.records[0].cards).toEqual(original.cards);
    expect(result.records[0].sourcePath).toBe(h.file.path);
    (h.file.cache!.frontmatter as {tags: string[]}).tags = [];
    result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("out-of-scope");
    expect(result.records[0].cards).toEqual(original.cards);
    (h.file.cache!.frontmatter as {tags: string[]}).tags = ["note", "card"];
    result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("active");
    expect(result.records[0].cards).toEqual(original.cards);
    expect(h.history.filter((e) => e.action === "delete")).toHaveLength(0);
  });
  it("keeps existing data while metadata is unavailable and does not initialize unknown files", async () => {
    const h = harness(); await h.scanner.scan();
    const before = structuredClone([...h.records.values()]);
    h.file.cache = null;
    const result = await h.scanner.scan();
    expect(result.records).toEqual(before);
    expect(h.history.filter((e) => e.action === "delete")).toHaveLength(0);
    const empty = harness([]); await empty.scanner.scan();
    expect(empty.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });
  it("does not transfer an out-of-scope original's identity to its tagged copy", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    const copy = structuredClone(h.file); copy.path = "新目录/副本.md"; copy.basename = "副本";
    (h.file.cache!.frontmatter as {tags: string[]}).tags = [];
    h.files.push(copy);
    const result = await h.scanner.scan();
    expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.sourcePath === h.file.path)?.reviewId).toBe(first.reviewId);
    expect(result.records.find((r) => r.sourcePath === copy.path)?.reviewId).not.toBe(first.reviewId);
  });
  it("retains history after a real source deletion", async () => {
    const h = harness(); await h.scanner.scan(); const count = h.history.length;
    h.files.splice(0); const result = await h.scanner.scan();
    expect(result.records).toHaveLength(0);
    expect(h.history.length).toBeGreaterThan(count);
    expect(h.history.some((e) => e.action === "create")).toBe(true);
  });
  it("blocks malformed card sections without blocking note reviews or dropping cards", async () => {
    const h = harness(); const original = (await h.scanner.scan()).records[0];
    h.file.content += "\n## 复习\n重复标题";
    const result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("parse-error");
    expect(result.records[0].cards).toEqual(original.cards);
    expect(collectEntries(result.records, "note", h.settings)).toHaveLength(1);
    expect(collectEntries(result.records, "card", h.settings)).toHaveLength(0);
  });

});
