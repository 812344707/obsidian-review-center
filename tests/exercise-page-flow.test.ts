import { beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => {
  class Base { register() {} }
  class TFile { path = ""; basename = ""; }
  class TFolder { path = ""; }
  class MarkdownView {
    file?: InstanceType<typeof TFile>;
    leaf: unknown;
    editor: unknown;
    constructor() {
      this.editor = {
        lastLine: () => 7, getCursor: () => ({ line: 2, ch: 3 }), replaceRange: vi.fn(),
        setCursor: vi.fn(), scrollIntoView: vi.fn(), focus: vi.fn(),
      };
    }
    getMode() { return "source"; }
    getViewType() { return "markdown"; }
  }
  return {
    Plugin: class { constructor(public app: unknown, public manifest: unknown) {} },
    MarkdownView, TFile, TFolder,
    Notice: class { constructor(message: string) { notices.push(message); } },
    Modal: Base, ItemView: Base, Component: Base, PluginSettingTab: Base, AbstractInputSuggest: Base,
    Setting: Base, Menu: Base, Platform: {}, MarkdownRenderer: {}, setIcon: vi.fn(), normalizePath: (path: string) => path,
    getAllTags: (cache: { tags?: string[] }) => cache.tags ?? [],
  };
});

import { MarkdownView, TFile, TFolder, type App, type PluginManifest } from "obsidian";
import ReviewCenterPlugin from "../src/main";
import { normalizeSettings } from "../src/config";

function harness(openFailure = false, createFailure = false) {
  const files = new Map<string, TFile | TFolder>();
  const contents = new Map<string, string>();
  const source = Object.assign(new TFile(), { path: "资料/伤寒论.md", basename: "伤寒论" });
  files.set(source.path, source); contents.set(source.path, "原文保持不变");
  const sourceView = new MarkdownView({} as never); sourceView.file = source;
  let activeView = sourceView;
  let activeLeaf: unknown = null;
  const leaves: Array<{ view: MarkdownView; openFile: ReturnType<typeof vi.fn> }> = [];
  const getLeaf = vi.fn(() => {
    const view = new MarkdownView({} as never);
    const leaf = {
      view,
      openFile: vi.fn(async (file: TFile) => {
        if (openFailure) throw new Error("无法显示标签页");
        view.file = file; activeView = view;
      }),
    };
    view.leaf = leaf as never; leaves.push(leaf); return leaf;
  });
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: vi.fn(async (path: string) => {
        const folder = Object.assign(new TFolder(), { path }); files.set(path, folder); return folder;
      }),
      create: vi.fn(async (path: string, markdown: string) => {
        if (createFailure) throw new Error("无法创建文件");
        if (files.has(path)) throw new Error("文件已存在");
        const file = Object.assign(new TFile(), { path, basename: path.split("/").at(-1)!.replace(/\.md$/i, "") });
        files.set(path, file); contents.set(path, markdown); return file;
      }),
      cachedRead: vi.fn(async (file: TFile) => contents.get(file.path) ?? ""),
    },
    metadataCache: { getFileCache: (file: TFile) => file === source ? { tags: ["#复习/医学", "#经典"] } : {} },
    fileManager: { generateMarkdownLink: vi.fn((file: TFile) => file === source ? "[[资料/伤寒论|伤寒论]]" : `[[${file.basename}]]`) },
    workspace: {
      getActiveViewOfType: (type: typeof MarkdownView) => activeView instanceof type ? activeView : null,
      getLeaf,
      revealLeaf: vi.fn(async (leaf: unknown) => { activeLeaf = leaf; }),
      getMostRecentLeaf: () => activeLeaf,
    },
  };
  const plugin = new ReviewCenterPlugin(app as unknown as App, { version: "1.0.3" } as PluginManifest);
  plugin.settings = normalizeSettings({ exercisePageNameTemplate: "{{title}}-习题" });
  plugin.service = { maintenance: false, records: [] } as never;
  const sync = vi.fn(); Reflect.set(plugin, "overlay", { sync });
  return { plugin, app, files, contents, source, sourceView, getLeaf, leaves, sync, setActiveLeaf: (leaf: unknown) => { activeLeaf = leaf; } };
}

describe("creating exercise pages", () => {
  beforeEach(() => { notices.length = 0; });

  it("queues repeated clicks, creates unique notes and inserts their links at the captured source cursor", async () => {
    const h = harness();
    await Promise.all([h.plugin.createExercisePage(), h.plugin.createExercisePage()]);
    expect(h.sourceView.editor.replaceRange).toHaveBeenNthCalledWith(1, "[[伤寒论-习题]]", { line: 2, ch: 3 });
    expect(h.sourceView.editor.replaceRange).toHaveBeenNthCalledWith(2, "[[伤寒论-习题-2]]", { line: 2, ch: 3 });
    expect(h.contents.get("习题/伤寒论-习题.md")).toContain('tags: ["复习/医学","经典"]');
    expect(h.contents.get("习题/伤寒论-习题.md")).toContain("来源：[[资料/伤寒论|伤寒论]]");
    expect(h.files.has("习题/伤寒论-习题-2.md")).toBe(true);
    expect(h.getLeaf).toHaveBeenNthCalledWith(1, "tab");
    expect(h.getLeaf).toHaveBeenNthCalledWith(2, "tab");
    expect(h.leaves.every((leaf) => leaf.view.editor && leaf.openFile.mock.calls[0]?.[1]?.state?.mode === "source")).toBe(true);
    expect(h.plugin.getOverlayMode()).toBe("exercise");
    expect(h.plugin.getExercisePagePath()).toBe("习题/伤寒论-习题-2.md");
    expect(h.sync).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([]);
  });

  it("reports the saved path when opening the new tab fails", async () => {
    const h = harness(true);
    await h.plugin.createExercisePage();
    expect(h.files.has("习题/伤寒论-习题.md")).toBe(true);
    expect(notices[0]).toContain("习题页已保存到“习题/伤寒论-习题.md”");
  });

  it("does not edit the source when file creation fails", async () => {
    const h = harness(false, true);
    await h.plugin.createExercisePage();
    expect(h.sourceView.editor.replaceRange).not.toHaveBeenCalled();
    expect(notices[0]).toContain("无法创建文件");
  });

  it("recognizes a marked exercise page after it is reopened or moved", async () => {
    const h = harness();
    const file = Object.assign(new TFile(), { path: "归档/移动后的习题.md", basename: "移动后的习题" });
    h.files.set(file.path, file); h.contents.set(file.path, "---\nreview_id: exercise-moved-page\n---\n\n来源：[[伤寒论]]\n");
    const view = new MarkdownView({} as never); view.file = file;
    const leaf = {
      view,
      getViewState: () => ({ type: "markdown", state: { file: file.path } }),
    };
    view.leaf = leaf as never; h.setActiveLeaf(leaf);
    await Reflect.get(h.plugin, "detectExercisePage").call(h.plugin, leaf, file.path);
    expect(h.plugin.getOverlayMode()).toBe("exercise");
    expect(h.plugin.getExercisePagePath()).toBe(file.path);
    expect(h.sync).toHaveBeenCalledWith(leaf);
  });
});
