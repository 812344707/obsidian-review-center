import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class Base {}
  return {
    Plugin: class {
      constructor(public app: unknown, public manifest: unknown) {}
      registerEvent() {}
    },
    Notice: vi.fn(), Modal: Base, ItemView: Base, MarkdownView: Base,
    Component: Base, PluginSettingTab: Base, AbstractInputSuggest: Base,
    TFile: Base, TFolder: Base, Setting: Base, Menu: Base, Platform: {},
    normalizePath: (path: string) => path, getAllTags: () => [],
    getFrontMatterInfo: vi.fn(), setIcon: vi.fn(), MarkdownRenderer: {},
  };
});

import { Notice, type App, type PluginManifest } from "obsidian";
import ReviewCenterPlugin from "../src/main";
import { ReviewService } from "../src/service";
import type { ScanResult, VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import { fixtureRecord, fixtureSettings } from "./fixtures";
import type { SourceRecord } from "../src/types";
import type { ProgressReporter } from "../src/preparation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const vaultEvents = new Map<string, (...args: any[]) => void>();
  const metadataEvents = new Map<string, (...args: any[]) => void>();
  const app = {
    workspace: { getLeavesOfType: () => [] },
    vault: { on: (name: string, fn: (...args: any[]) => void) => vaultEvents.set(name, fn) },
    metadataCache: { on: (name: string, fn: (...args: any[]) => void) => metadataEvents.set(name, fn) },
  };
  const plugin = new ReviewCenterPlugin(app as unknown as App, { version: "0.4.2" } as PluginManifest);
  plugin.settings = fixtureSettings();
  const data: ScanResult = { records: [fixtureRecord()], history: [], conflicts: 0 };
  const scanner = {
    scan: vi.fn(async (_progress?: ProgressReporter) => structuredClone(data)),
    loadStored: vi.fn(async () => structuredClone(data)),
    verifyEntry: vi.fn(async (record: SourceRecord) => ({ record: structuredClone(data.records.find((r) => r.reviewId === record.reviewId) ?? record), history: structuredClone(data.history), sourceHash: "fixture" })),
    markSourceChanged: vi.fn(), markMetadataReady: vi.fn(), moveSource: vi.fn(), sourceCreated: vi.fn(),
  };
  plugin.store = { flush: vi.fn(async () => undefined) } as unknown as ReviewStore;
  plugin.service = new ReviewService(scanner as unknown as VaultScanner, {} as ReviewStore, () => plugin.settings, "0.4.2", () => {});
  const openNote = vi.spyOn(plugin as unknown as { openActiveNote(): Promise<void> }, "openActiveNote").mockResolvedValue();
  const openCenter = vi.spyOn(plugin, "openReviewCenter").mockResolvedValue();
  Reflect.get(plugin, "registerVaultEvents").call(plugin);
  return { plugin, data, scanner, openNote, openCenter, vaultEvents, metadataEvents };
}

describe("review start disk I/O and coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("document", { hidden: false });
    vi.mocked(Notice).mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("does not lose a second authored card when a prior local update finishes late", async () => {
    const h = harness(), first = deferred<void>(), second = deferred<void>();
    const refresh = vi.spyOn(h.plugin.service, "refreshSource").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const paths = Reflect.get(h.plugin, "authoringFiles") as Map<string, number>;
    const markdown = "> [!review]\n> {{c1::文字}}\n";
    paths.set("资料/source.md", 1);
    h.metadataEvents.get("changed")!({ path: "资料/source.md" }, markdown);
    await vi.advanceTimersByTimeAsync(700);
    expect(refresh).toHaveBeenCalledOnce();
    paths.set("资料/source.md", 2);
    h.metadataEvents.get("changed")!({ path: "资料/source.md" }, markdown);
    first.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(paths.get("资料/source.md")).toBe(2);
    await vi.advanceTimersByTimeAsync(700);
    expect(refresh).toHaveBeenCalledTimes(2);
    second.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(paths.has("资料/source.md")).toBe(false);
    expect(h.scanner.scan).not.toHaveBeenCalled();
  });

  it("follows a folder rename while a card draft is waiting to be saved", async () => {
    const h = harness(), paths = Reflect.get(h.plugin, "authoringFiles") as Map<string, number>;
    const refresh = vi.spyOn(h.plugin.service, "refreshSource").mockResolvedValue();
    paths.set("资料/source.md", 10);
    const markdown = "> [!review]\n> {{c1::文字}}\n";
    h.metadataEvents.get("changed")!({ path: "资料/source.md" }, markdown);
    h.vaultEvents.get("rename")!({ path: "新资料" }, "资料");
    h.metadataEvents.get("changed")!({ path: "新资料/source.md" }, markdown);
    await vi.advanceTimersByTimeAsync(700);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("新资料/source.md");
    expect(paths.size).toBe(0);
    expect(h.scanner.scan).not.toHaveBeenCalled();
  });

  it.each(["note", "card"] as const)("starts %s from the loaded index without rescanning 1000 unchanged sources", async (mode) => {
    const h = harness();
    h.data.records = Array.from({ length: 1000 }, (_, i) => fixtureRecord(`source-${i}`));
    await h.plugin.refreshData();
    h.scanner.scan.mockClear();
    await h.plugin.startReview(mode);
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(h.plugin.service.session?.mode).toBe(mode);
    expect(h.plugin.service.currentEntry()).not.toBeNull();
    expect(mode === "note" ? h.openNote : h.openCenter).toHaveBeenCalledOnce();
  });

  it("shows busy immediately, waits for first load and coalesces repeated start/continue requests", async () => {
    const h = harness(), scan = deferred<ScanResult>();
    h.scanner.loadStored.mockReturnValueOnce(scan.promise);
    const start = vi.spyOn(h.plugin.service, "startOrResumeSession");
    const first = h.plugin.startReview("note");
    expect(h.plugin.startingReview).toBe(true);
    expect(h.plugin.startReview("card")).toBe(first);
    expect(h.plugin.continueReview()).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scanner.loadStored).toHaveBeenCalledOnce();
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(h.openNote).not.toHaveBeenCalled();
    scan.resolve(h.data);
    await first;
    expect(start).toHaveBeenCalledOnce();
    expect(h.openNote).toHaveBeenCalledOnce();
    expect(h.plugin.startingReview).toBe(false);
  });

  it("verifies the changed current source without scheduling or awaiting a full scan", async () => {
    const h = harness(); await h.plugin.refreshData(); h.scanner.scan.mockClear();
    h.vaultEvents.get("modify")!({ path: "资料/source.md" });
    h.data.records[0].tags = ["unrelated"];
    await h.plugin.startReview("note");
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(h.scanner.verifyEntry).toHaveBeenCalledOnce();
    expect(h.openNote).not.toHaveBeenCalled();
    expect(h.plugin.service.currentEntry()).toBeNull();
    await vi.advanceTimersByTimeAsync(2400);
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(h.plugin.materialsDirty).toBe(true);
  });

  it("waits for an existing scan without starting another or rendering the home before opening", async () => {
    const h = harness(), scan = deferred<ScanResult>();
    h.scanner.scan.mockReturnValueOnce(scan.promise);
    const refresh = h.plugin.refreshData();
    const renderHome = vi.fn(); Reflect.set(h.plugin, "renderOpenViews", renderHome);
    const starting = h.plugin.startReview("card");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.openCenter).not.toHaveBeenCalled();
    scan.resolve(h.data); await refresh; await starting;
    expect(h.scanner.scan).toHaveBeenCalledOnce();
    expect(renderHome).not.toHaveBeenCalled();
    expect(h.openCenter).toHaveBeenCalledWith(false);
  });

  it("does not consume a restored queue when metadata is not ready", async () => {
    const h = harness();
    const session = { id: "saved", mode: "card" as const, entryKeys: ["source::rv-one:qa"], currentIndex: 0, answerVisible: true, startedAt: new Date().toISOString() };
    h.plugin.service.restoreLocalSession(structuredClone(session));
    h.scanner.verifyEntry.mockRejectedValueOnce(new Error("索引未就绪"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await h.plugin.startReview("card");
    expect(h.plugin.service.hasLoaded).toBe(true);
    expect(h.plugin.service.session).toMatchObject(session);
    expect(h.openCenter).not.toHaveBeenCalled();
    expect(h.plugin.startingReview).toBe(false);
    await h.plugin.startReview("card");
    expect(h.plugin.service.session?.id).toBe("saved");
    expect(h.plugin.service.session?.answerVisible).toBe(true);
    expect(h.openCenter).toHaveBeenCalledWith(false);
  });

  it("does not open an unverified source after a read error and retries on the next click", async () => {
    const h = harness(); await h.plugin.refreshData();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.vaultEvents.get("modify")!({ path: "资料/source.md" });
    h.scanner.verifyEntry.mockRejectedValueOnce(new Error("read failed"));
    await h.plugin.startReview("note");
    expect(h.openNote).not.toHaveBeenCalled();
    expect(h.plugin.startingReview).toBe(false);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("read failed"));
    await h.plugin.startReview("note");
    expect(h.openNote).toHaveBeenCalledOnce();
  });

  it("does not rescan after unrelated metadata resolves or data-folder writes", async () => {
    const h = harness(); await h.plugin.refreshData(); h.scanner.scan.mockClear();
    h.metadataEvents.get("changed")!({ path: "其他.md" }, "正文");
    h.vaultEvents.get("modify")!({ path: h.plugin.settings.dataFolder + "/records/no/source.json" });
    h.vaultEvents.get("modify")!({ path: h.plugin.settings.dataFolder + "/readme.md" });
    await vi.advanceTimersByTimeAsync(2400);
    await h.plugin.startReview("note");
    expect(h.scanner.scan).not.toHaveBeenCalled();
  });

  it("coalesces preparation clicks and does not schedule another full scan for source events", async () => {
    const h = harness(); await h.plugin.refreshData(); h.scanner.scan.mockClear();
    const scan = deferred<ScanResult>(); h.scanner.scan.mockReturnValueOnce(scan.promise);
    const refresh = h.plugin.refreshData();
    const again = h.plugin.refreshData();
    await vi.advanceTimersByTimeAsync(0);
    h.vaultEvents.get("modify")!({ path: "资料/source.md" });
    await vi.advanceTimersByTimeAsync(1200);
    scan.resolve(h.data); await refresh; await again;
    h.data.records[0].tags = [];
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.scanner.scan).toHaveBeenCalledOnce();
    await h.plugin.startReview("note");
    expect(h.scanner.scan).toHaveBeenCalledOnce();
    expect(h.openNote).not.toHaveBeenCalled();
  });

  it("reports an opening failure, clears the busy state and allows retry", async () => {
    const h = harness(); await h.plugin.refreshData();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.openNote.mockRejectedValueOnce(new Error("open failed"));
    await h.plugin.startReview("note");
    expect(h.plugin.startingReview).toBe(false);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("open failed"));
    await h.plugin.startReview("note");
    expect(h.openNote).toHaveBeenCalledTimes(2);
  });

  it("shows real preparation progress and only reaches 100 after writes finish", async () => {
    const h = harness(), saving = deferred<void>();
    vi.spyOn(h.plugin.store, "flush").mockReturnValue(saving.promise);
    h.scanner.scan.mockImplementationOnce(async (report) => {
      report?.({ percent: 36, message: "检查材料 8/10" });
      expect(h.plugin.preparation).toMatchObject({ state: "running", percent: 36 });
      report?.({ percent: 99, message: "保存复习清单" });
      return h.data;
    });
    const work = h.plugin.refreshData();
    expect(h.plugin.preparation).toMatchObject({ state: "running", percent: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.plugin.preparation.percent).toBe(99);
    saving.resolve(); await work;
    expect(h.plugin.preparation).toMatchObject({ state: "done", percent: 100 });
  });

  it("keeps the last progress on failure and allows preparation to be retried", async () => {
    const h = harness(); vi.spyOn(console, "error").mockImplementation(() => {});
    h.scanner.scan.mockImplementationOnce(async (report) => {
      report?.({ percent: 62, message: "整理材料" }); throw new Error("read failed");
    });
    expect(await h.plugin.refreshData()).toBe(false);
    expect(h.plugin.preparation).toMatchObject({ state: "error", percent: 62 });
    expect(await h.plugin.refreshData()).toBe(true);
    expect(h.plugin.preparation).toMatchObject({ state: "done", percent: 100 });
  });

  it("asks for explicit preparation on first use instead of scanning after Start", async () => {
    const h = harness(); h.data.records = [];
    await h.plugin.startReview("note");
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("整理数据"));
    expect(h.openCenter).toHaveBeenCalledWith(true);
  });

  it("does not mark startup create events as edits waiting for reindexing", async () => {
    const h = harness();
    h.vaultEvents.get("create")!({ path: "资料/source.md" });
    await h.plugin.startReview("note");
    expect(h.scanner.markSourceChanged).not.toHaveBeenCalled();
    expect(h.scanner.sourceCreated).toHaveBeenCalledWith("资料/source.md");
    expect(h.scanner.scan).not.toHaveBeenCalled();
    expect(h.openNote).toHaveBeenCalledOnce();
  });
});
