import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
  class Base { register() {} }
  return {
    Plugin: class { constructor(public app: unknown, public manifest: unknown) {} },
    MarkdownView: class {}, TFile: class {},
    Notice: vi.fn(), Modal: Base, ItemView: Base, Component: Base,
    PluginSettingTab: Base, AbstractInputSuggest: Base, TFolder: Base,
    Setting: Base, Menu: Base, Platform: {}, MarkdownRenderer: {},
    normalizePath: (path: string) => path, getAllTags: () => [],
  };
});

import { MarkdownView, Notice, TFile, type App, type PluginManifest } from "obsidian";
import ReviewCenterPlugin from "../src/main";
import { ReviewOverlay } from "../src/overlay";
import { ReviewService } from "../src/service";
import { REVIEW_CENTER_VIEW } from "../src/view";
import type { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import { fixtureRecord, fixtureSettings, fixtureVerifier } from "./fixtures";

function harness() {
  const record = fixtureRecord(), file = Object.assign(new TFile(), { path: record.sourcePath });
  const doc = { body: { createDiv: () => ({ remove: vi.fn() }), addClass: vi.fn(), removeClass: vi.fn() } };
  function makeLeaf(type: string, source?: TFile) {
    const view = Object.assign(type === "markdown" ? new MarkdownView({} as never) : {}, {
      file: source, getViewType: () => type,
      containerEl: { doc, isConnected: true },
      editor: { setCursor: vi.fn(), scrollIntoView: vi.fn() },
    });
    return {
      view, isDeferred: false, loadIfDeferred: vi.fn(async () => {}),
      getViewState: () => ({ type, state: { file: view.file?.path } }),
      // A closed Obsidian leaf can still resolve openFile without reattaching.
      openFile: vi.fn(async (next: TFile) => { view.file = next; }),
    };
  }
  const home = makeLeaf(REVIEW_CENTER_VIEW), leaves = [home];
  let active = home;
  const workspace = {
    getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
    iterateAllLeaves: (callback: (leaf: ReturnType<typeof makeLeaf>) => void) => leaves.forEach(callback),
    getMostRecentLeaf: () => active,
    getActiveViewOfType: (type: typeof MarkdownView) => active.view instanceof type ? active.view : null,
    getLeaf: vi.fn(() => { const leaf = makeLeaf("markdown"); leaves.push(leaf); return leaf; }),
    setActiveLeaf: vi.fn((leaf: ReturnType<typeof makeLeaf>) => { if (leaves.includes(leaf)) active = leaf; }),
    revealLeaf: vi.fn(async (leaf: ReturnType<typeof makeLeaf>) => { if (leaves.includes(leaf)) active = leaf; }),
  };
  const plugin = new ReviewCenterPlugin({ workspace, vault: { getAbstractFileByPath: () => file } } as unknown as App, { version: "1.0.0" } as PluginManifest);
  plugin.settings = fixtureSettings();
  const scanner = { ...fixtureVerifier(), loadStored: async () => ({ records: [record], history: [], conflicts: 0 }) };
  plugin.service = new ReviewService(scanner as unknown as VaultScanner, {} as ReviewStore, () => plugin.settings, "1.0.0", () => {});
  const overlay = new ReviewOverlay(plugin);
  const renderOverlay = vi.spyOn(overlay as unknown as { render(mode: string): void }, "render").mockImplementation(() => {});
  Reflect.set(plugin, "overlay", overlay);
  const close = (leaf: ReturnType<typeof makeLeaf>) => {
    leaves.splice(leaves.indexOf(leaf), 1);
    leaf.view.containerEl.isConnected = false;
    active = home;
  };
  return { plugin, workspace, home, file, leaves, overlay, renderOverlay, close, active: () => active };
}

describe("opening the note in a live workspace tab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("document", { hidden: false });
    vi.mocked(Notice).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("coalesces repair clicks, clears stale tab state and blocks Start until repair finishes", async () => {
    const h = harness();
    await h.plugin.startReview("note");
    const sessionId = h.plugin.service.session!.id;
    let finish!: () => void;
    const repair = vi.spyOn(h.plugin.service, "repair").mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ records: 1, issues: 0, backupPath: "pre-repair.json" });
    }));
    const first = h.plugin.repairVault();
    expect(h.plugin.repairVault()).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(repair).toHaveBeenCalledOnce();
    expect(h.plugin.getOverlayMode()).toBeNull();
    expect(Reflect.get(h.plugin, "sourceLeaf")).toBeNull();
    await h.plugin.startReview("note");
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("正在修复"));
    finish(); await first;
    expect(h.plugin.repairingVault).toBe(false);
    expect(h.plugin.preparation).toMatchObject({ state: "done", percent: 100 });
    expect(h.plugin.service.session!.id).toBe(sessionId);
  });

  it("reopens the same session after the previous note tab was closed", async () => {
    const h = harness();
    await h.plugin.startReview("note");
    const previous = h.active(), sessionId = h.plugin.service.session!.id;
    h.close(previous);
    await h.plugin.startReview("note");
    expect(h.active()).not.toBe(h.home);
    expect(h.active()).not.toBe(previous);
    expect(h.active().view.file).toBe(h.file);
    expect(previous.openFile).toHaveBeenCalledOnce();
    expect(h.plugin.service.session!.id).toBe(sessionId);
    expect(h.plugin.service.session!.currentIndex).toBe(0);
    expect(h.plugin.service.history).toEqual([]);
  });

  it("reuses a note tab that is still attached", async () => {
    const h = harness();
    await h.plugin.startReview("note");
    const previous = h.active();
    h.workspace.setActiveLeaf(h.home);
    await h.plugin.startReview("note");
    expect(h.active()).toBe(previous);
    expect(h.workspace.getLeaf).toHaveBeenCalledOnce();
  });

  it("recovers if a tab closes while openFile is resolving without throwing", async () => {
    const h = harness(), previous = h.workspace.getLeaf();
    Reflect.set(h.plugin, "sourceLeaf", previous);
    previous.openFile.mockImplementationOnce(async (file) => { previous.view.file = file; h.close(previous); });
    await h.plugin.startReview("note");
    expect(h.active()).not.toBe(h.home);
    expect(h.active()).not.toBe(previous);
    expect(h.active().view.file).toBe(h.file);
    expect(h.workspace.setActiveLeaf).not.toHaveBeenCalledWith(previous, expect.anything());
  });

  it("reports a silent reveal failure instead of returning a background note as success", async () => {
    const h = harness();
    h.workspace.setActiveLeaf.mockImplementation(() => {});
    h.workspace.revealLeaf.mockImplementation(async () => {});
    const start = h.plugin.startReview("note");
    await vi.advanceTimersByTimeAsync(2500);
    await start;
    expect(h.active()).toBe(h.home);
    expect(Notice).toHaveBeenCalledWith(expect.stringContaining("无法开始复习"));
    expect(h.plugin.showDashboard).toBe(true);
    expect(h.plugin.startingReview).toBe(false);
    expect(h.plugin.getOverlayMode()).toBeNull();
    expect(h.renderOverlay).not.toHaveBeenCalled();
  });

  it("does not show a rating bar on the home page while the note is opening", async () => {
    const h = harness(), leaf = h.workspace.getLeaf();
    Reflect.set(h.plugin, "sourceLeaf", leaf);
    let complete!: () => void;
    leaf.openFile.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = () => { leaf.view.file = h.file; resolve(); }; }));
    const start = h.plugin.startReview("note");
    await vi.advanceTimersByTimeAsync(400);
    expect(h.active()).toBe(h.home);
    expect(h.renderOverlay).not.toHaveBeenCalled();
    complete(); await start;
    expect(h.active()).toBe(leaf);
    expect(h.renderOverlay).toHaveBeenCalled();
  });

  it("does not recreate the rating bar after returning to the home tab during delayed callbacks", async () => {
    const h = harness();
    await h.plugin.startReview("note");
    h.workspace.setActiveLeaf(h.home);
    Reflect.get(h.plugin, "syncActiveLeaf").call(h.plugin, h.home);
    h.renderOverlay.mockClear();
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.renderOverlay).not.toHaveBeenCalled();
  });

  it("does not attach an overlay to a detached note even if its path still matches", async () => {
    const h = harness();
    await h.plugin.startReview("note");
    const previous = h.active();
    h.close(previous);
    h.renderOverlay.mockClear();
    h.overlay.sync(previous as never);
    expect(h.renderOverlay).not.toHaveBeenCalled();
  });
});
