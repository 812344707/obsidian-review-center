import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
vi.mock("obsidian", () => ({
  TFile: class {}, normalizePath: (value: string) => value,
  getAllTags: (cache: { frontmatter?: { tags?: string[] } }) => (cache.frontmatter?.tags ?? []).map((tag) => `#${tag}`),
}));
import { TFile, type App } from "obsidian";
import { VaultScanner } from "../src/scanner";
import { ReviewService } from "../src/service";
import type { ReviewStore } from "../src/storage";
import type { HistoryEvent, SourceRecord } from "../src/types";
import { createHistoryEvent } from "../src/history";
import { applyRating } from "../src/scheduler";
import { fixtureSettings, today } from "./fixtures";

async function harness() {
  const settings = fixtureSettings();
  const file = { path: "资料/source.md", basename: "source", stat: { ctime: today.getTime(), mtime: today.getTime() },
    content: "---\nreview_id: source\ntags: [note, card]\n---\n\n原笔记正文\n\n> [!review]- 复习\n> 问:: 问题\n> 答:: 答案\n> ^rv-one\n" };
  const files = [file];
  Object.setPrototypeOf(file, TFile.prototype);
  const records = new Map<string, SourceRecord>();
  const history: HistoryEvent[] = [];
  const app = { vault: { getMarkdownFiles: () => files, getAbstractFileByPath: (path: string) => files.find((file) => file.path === path), read: vi.fn(async (f: typeof file) => f.content),
    process: vi.fn(async (f: typeof file, change: (text: string) => string) => { f.content = change(f.content); }) },
    metadataCache: { getFileCache: vi.fn((f: typeof file) => ({ frontmatter: parse(f.content.split("---")[1] || "{}") })) },
    fileManager: { processFrontMatter: vi.fn() } };
  const store = { sessionId: "local", deviceId: "desktop", initialize: vi.fn(),
    loadAllRecords: vi.fn(async () => structuredClone([...records.values()])),
    loadRecord: vi.fn(async (id: string) => structuredClone(records.get(id) ?? null)),
    loadAllHistory: vi.fn(async () => structuredClone(history)),
    saveRecord: vi.fn(async (r: SourceRecord) => { records.set(r.reviewId, structuredClone(r)); }),
    appendHistory: vi.fn(async (events: HistoryEvent[]) => { history.push(...structuredClone(events)); }),
    deleteRecord: vi.fn(async (id: string) => { records.delete(id); }), writeBackup: vi.fn(), backupSource: vi.fn() };
  const scanner = new VaultScanner(app as unknown as App, store as unknown as ReviewStore, () => settings);
  const service = new ReviewService(scanner, store as unknown as ReviewStore, () => settings, "0.4.2", () => {});
  await service.refresh();
  const scan = vi.spyOn(scanner, "scan");
  app.vault.read.mockClear(); store.loadAllRecords.mockClear(); store.saveRecord.mockClear();
  return { settings, file, files, records, history, app, store, scanner, service, scan };
}

describe("current material and cross-device progress verification", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(today); });
  afterEach(() => vi.useRealTimers());

  it("loads the saved list without reading Markdown and verifies only the current file among 1000 unrelated notes", async () => {
    const h = await harness();
    for (let i = 0; i < 1000; i++) h.files.push({ ...h.file, path: `其他/${i}.md`, content: `---\nreview_id: other-${i}\ntags: []\n---\n无关正文` });
    await h.service.loadStored(); expect(h.app.vault.read).not.toHaveBeenCalled();
    h.store.loadAllRecords.mockClear();
    h.app.metadataCache.getFileCache.mockClear();
    h.service.startSession("card"); await h.service.prepareCurrent(); await h.service.gradeCurrent(3);
    expect(h.scan).not.toHaveBeenCalled(); expect(h.store.loadAllRecords).not.toHaveBeenCalled();
    expect(h.app.vault.read.mock.calls.every(([file]) => file.path === h.file.path)).toBe(true);
    expect(h.history.filter((event) => event.action === "review")).toHaveLength(1);
    expect(h.store.saveRecord).toHaveBeenCalledOnce();
    expect(h.app.metadataCache.getFileCache.mock.calls.length).toBeLessThan(6);
  });

  it("blocks grading changed card content until it is reviewed and accepted", async () => {
    const h = await harness(); h.service.startSession("card"); await h.service.prepareCurrent();
    const before = structuredClone(h.records.get("source")!);
    h.file.content = h.file.content.replace("答:: 答案", "答:: 修改后的答案");
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("本次未评分");
    expect(h.service.currentPendingChange()).toBe(true);
    expect(h.records.get("source")).toEqual(before);
    expect(h.history.filter((event) => event.action === "review")).toHaveLength(0);
    await h.service.resolveChanges([{ sourceId: "source", itemId: "rv-one:qa", reset: false }]);
    await h.service.prepareCurrent(); await h.service.gradeCurrent(3);
    expect(h.history.filter((event) => event.action === "review")).toHaveLength(1);
  });

  it("detects a note body edited while being reviewed even if no file event arrived", async () => {
    const h = await harness(); h.service.startSession("note"); await h.service.prepareCurrent();
    h.file.content = h.file.content.replace("原笔记正文", "离线修改后的正文");
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("本次未评分");
    expect(h.store.saveRecord).not.toHaveBeenCalled();
    await h.service.prepareCurrent(); await h.service.gradeCurrent(3);
    expect(h.history.filter((event) => event.action === "review")).toHaveLength(1);
  });

  it("rechecks phone progress before accepting a changed card", async () => {
    const h = await harness(); h.service.startSession("card"); const shown = (await h.service.prepareCurrent())!;
    h.file.content = h.file.content.replace("答:: 答案", "答:: 新答案");
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("本次未评分");
    const after = applyRating(shown.item, 3, shown.group.parameters);
    h.records.get("source")!.cards[shown.item.id] = after;
    await expect(h.service.resolveChanges([{ sourceId: "source", itemId: shown.item.id, reset: false }])).rejects.toThrow("重新核对");
    expect(h.store.saveRecord).not.toHaveBeenCalled();
    expect(h.records.get("source")!.cards[shown.item.id].schedule).toEqual(after.schedule);
  });

  it("finds an offline rename by source identity and preserves its schedule", async () => {
    const h = await harness(), before = structuredClone(h.records.get("source")!.cards);
    h.file.path = "改名目录/新名字.md"; h.file.basename = "新名字";
    h.service.startSession("card"); const entry = await h.service.prepareCurrent();
    expect(entry?.sourcePath).toBe(h.file.path); expect(entry?.sourceTitle).toBe("新名字");
    expect(h.service.records[0].cards).toEqual(before); expect(h.scan).not.toHaveBeenCalled();
  });

  it("handles a live rename without waiting for a metadata-changed event that Obsidian does not emit", async () => {
    const h = await harness();
    h.scanner.markMetadataReady(h.file.path, h.file.content);
    const oldPath = h.file.path; h.file.path = "资料/改名.md"; h.file.basename = "改名";
    h.service.sourceRenamed(oldPath, h.file.path);
    h.service.startSession("card"); expect((await h.service.prepareCurrent())?.sourcePath).toBe(h.file.path);
    await h.service.gradeCurrent(3);
    expect(h.store.saveRecord).toHaveBeenCalledOnce();
  });

  it.each(["file", "card", "tag"])("does not grade a removed %s or advance a stale click onto the next item", async (kind) => {
    const h = await harness(); h.service.startSession("card"); await h.service.prepareCurrent();
    if (kind === "file") h.files.length = 0;
    else if (kind === "card") h.file.content = h.file.content.slice(0, h.file.content.indexOf("> [!review]"));
    else h.file.content = h.file.content.replace("[note, card]", "[]");
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("本次未评分");
    expect(h.store.saveRecord).not.toHaveBeenCalled();
    expect(h.history.filter((event) => event.action === "review")).toHaveLength(0);
  });

  it.each(["history-first", "snapshot-first"])("preserves a phone rating delivered %s and does not grade the old queue", async (order) => {
    const h = await harness(); h.service.startSession("card"); const shown = (await h.service.prepareCurrent())!;
    const after = applyRating(shown.item, 3, shown.group.parameters);
    const remote = createHistoryEvent({ sessionId: "phone", deviceId: "phone", sourceId: "source", itemId: shown.item.id,
      action: "review", baseRevision: shown.item.revision, after, rating: 3, now: today });
    if (order === "history-first") h.history.push(remote);
    else h.records.get("source")!.cards[shown.item.id] = structuredClone(after);
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("本次未评分");
    expect(h.service.records[0].cards[shown.item.id].schedule).toEqual(after.schedule);
    expect(h.store.saveRecord).not.toHaveBeenCalled();
    expect(h.history.filter((event) => event.action === "review" && event.deviceId === "desktop")).toHaveLength(0);
  });

  it("keeps an unverified source in place on metadata/read failure and allows retry", async () => {
    const h = await harness(); h.service.startSession("card"); await h.service.prepareCurrent();
    h.file.content = h.file.content.replace("原笔记正文", "新正文");
    h.scanner.markSourceChanged(h.file.path);
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("索引");
    expect(h.service.session?.currentIndex).toBe(0); expect(h.store.saveRecord).not.toHaveBeenCalled();
    h.scanner.markMetadataReady(h.file.path, h.file.content);
    h.store.loadRecord.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(h.service.gradeCurrent(3)).rejects.toThrow("disk unavailable");
    await h.service.gradeCurrent(3);
    expect(h.history.filter((event) => event.action === "review")).toHaveLength(1);
  });
});
