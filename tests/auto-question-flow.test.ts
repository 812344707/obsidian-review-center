import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ notices: [] as string[], request: vi.fn() }));
vi.mock("../src/auto-question-api", () => ({ requestAutoQuestions: state.request }));
vi.mock("obsidian", () => {
  class Base { register() {} }
  class TFile { path = ""; basename = ""; extension = "md"; }
  class TFolder { path = ""; }
  class MarkdownView { file?: InstanceType<typeof TFile>; }
  return {
    Plugin: class { constructor(public app: unknown, public manifest: unknown) {} },
    MarkdownView, TFile, TFolder,
    Notice: class { constructor(message: string) { state.notices.push(message); } },
    Modal: Base, ItemView: Base, Component: Base, PluginSettingTab: Base, AbstractInputSuggest: Base,
    Setting: Base, Menu: Base, Platform: {}, MarkdownRenderer: {}, setIcon: vi.fn(), normalizePath: (path: string) => path,
    getAllTags: (cache: { tags?: string[] }) => cache.tags ?? [],
  };
});

import { MarkdownView, TFile, TFolder, type App, type PluginManifest } from "obsidian";
import ReviewCenterPlugin from "../src/main";
import { normalizeSettings } from "../src/config";
import { parseReviewCards } from "../src/parser";

describe("automatic question file flow", () => {
  it("generates the initial batch into one parser-valid bank from the active source", async () => {
    state.notices.length = 0;
    state.request.mockReset();
    state.request.mockResolvedValue([
      { question: "第一题？", answer: "第一答", explanation: "第一条依据" },
      { question: "第二题？", answer: "第二答", explanation: "第二条依据" },
    ]);
    const files = new Map<string, TFile | TFolder>();
    const contents = new Map<string, string>();
    const source = Object.assign(new TFile(), { path: "资料/原文.md", basename: "原文", extension: "md" });
    files.set(source.path, source);
    contents.set(source.path, "---\ntags: [review]\n---\n\n# 原文\n\n正文内容");
    const activeView = Object.assign(new MarkdownView({} as never), { file: source });
    const opened: TFile[] = [];
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        getMarkdownFiles: () => [...files.values()].filter((file): file is TFile => file instanceof TFile),
        cachedRead: vi.fn(async (file: TFile) => contents.get(file.path) ?? ""),
        createFolder: vi.fn(async (path: string) => {
          const folder = Object.assign(new TFolder(), { path }); files.set(path, folder); return folder;
        }),
        create: vi.fn(async (path: string, markdown: string) => {
          const file = Object.assign(new TFile(), { path, basename: path.split("/").at(-1)!.replace(/\.md$/i, ""), extension: "md" });
          files.set(path, file); contents.set(path, markdown); return file;
        }),
      },
      metadataCache: {
        getFileCache: (file: TFile) => file === source ? { tags: ["#review"], frontmatter: { tags: ["review"] } } : undefined,
      },
      fileManager: { generateMarkdownLink: () => "[[资料/原文|原文]]" },
      secretStorage: { getSecret: vi.fn(() => null) },
      workspace: {
        getActiveViewOfType: (type: typeof MarkdownView) => activeView instanceof type ? activeView : null,
        getLeavesOfType: () => [],
        getLeaf: () => ({ openFile: vi.fn(async (file: TFile) => { opened.push(file); }) }),
        revealLeaf: vi.fn(async () => {}),
      },
    };
    const plugin = new ReviewCenterPlugin(app as unknown as App, { version: "1.3.1" } as PluginManifest);
    plugin.settings = normalizeSettings({ autoQuestion: { model: "study-model", batchSize: 2 } });
    plugin.settings.cardGroups[0].tags = ["review"];
    plugin.service = { maintenance: false, hasLoaded: true, records: [], history: [] } as never;
    vi.spyOn(plugin, "refreshData").mockResolvedValue(true);
    Reflect.set(plugin, "waitForAutoQuestionMetadata", vi.fn(async () => true));

    await plugin.runAutoQuestionGeneration();

    const path = "自动题库/原文-自动题库.md";
    const markdown = contents.get(path)!;
    expect(state.request).toHaveBeenCalledWith(
      expect.objectContaining({ model: "study-model", batchSize: 2 }), null, expect.stringContaining("正文内容"), 2, [],
    );
    expect(parseReviewCards(markdown)).toMatchObject({ valid: true, cards: [{ content: { question: "第一题？" } }, { content: { question: "第二题？" } }] });
    expect(markdown).toContain('auto_question_source: "资料/原文.md"');
    expect(opened[0]?.path).toBe(path);
    expect(state.notices.at(-1)).toContain(`已写入 2 道题：${path}`);
  });
});
