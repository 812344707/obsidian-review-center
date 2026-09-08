import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ ItemView: class {}, Modal: class {}, Notice: vi.fn(), Menu: class {}, setIcon: vi.fn(),
  MarkdownRenderer: { render: vi.fn(async () => {}) } }));
import { MarkdownRenderer } from "obsidian";
import { ReviewCenterView } from "../src/view";
import { fixtureItem, fixtureSettings } from "./fixtures";

class Element {
  children: Element[] = [];
  handlers: Record<string, () => void> = {};
  disabled = false;
  constructor(readonly options: { text?: string; cls?: string } = {}) {}
  createEl(_tag: string, options = {}): Element { const el = new Element(options); this.children.push(el); return el; }
  createDiv(options = {}): Element { return this.createEl("div", options); }
  createSpan(options = {}): Element { return this.createEl("span", options); }
  addEventListener(type: string, handler: () => void): void { this.handlers[type] = handler; }
  addClass(cls: string): void { this.options.cls = [this.options.cls, cls].filter(Boolean).join(" "); }
  empty(): void { this.children = []; }
  remove(): void {}
  all(): Element[] { return this.children.flatMap(el => [el, ...el.all()]); }
}

describe("revealing supplementary Markdown", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["qa", "cloze"] as const)("keeps %s Extra off the front and renders only its content on the back", async (kind) => {
    const item = fixtureItem(); item.kind = kind; item.clozeIndex = kind === "cloze" ? 1 : undefined;
    item.content = { ...item.content, raw: "正文 {{c1::答案}}", extra: "解释\n![[附件/图.png|500]]" };
    const entry = { item, sourcePath: "资料/笔记.md", sourceTitle: "笔记", tags: [], group: fixtureSettings().cardGroups[0] };
    const service = { currentEntry: () => entry, progress: () => ({ current: 1, total: 1 }),
      session: { answerVisible: false }, setAnswerVisible: vi.fn((value: boolean) => { service.session.answerVisible = value; }), canUndo: () => false };
    const view = new ReviewCenterView({} as never, { service } as never);
    const grades = vi.fn(); Reflect.set(view, "renderGrades", grades);
    const root = new Element();
    await Reflect.get(view, "renderCardSession").call(view, root, 0);
    expect(root.all().some(el => el.options.text === "补充")).toBe(false);
    expect(vi.mocked(MarkdownRenderer.render).mock.calls).toHaveLength(1);
    expect(vi.mocked(MarkdownRenderer.render).mock.calls[0][1]).not.toContain("Extra:");
    root.all().find(el => el.options.text === "显示答案")!.handlers.click();
    await vi.waitFor(() => expect(grades).toHaveBeenCalledOnce());
    expect(service.setAnswerVisible).toHaveBeenCalledWith(true);
    expect(root.all().filter(el => el.options.text === "补充")).toHaveLength(1);
    const extraCalls = () => vi.mocked(MarkdownRenderer.render).mock.calls.filter(call => call[1] === item.content.extra);
    expect(extraCalls()).toHaveLength(1);
    expect(extraCalls()[0][1]).toBe("解释\n![[附件/图.png|500]]");
    expect(extraCalls()[0][1]).not.toContain("Extra:");
    expect(extraCalls()[0][3]).toBe(entry.sourcePath);
    vi.mocked(MarkdownRenderer.render).mockClear();
    const resumed = new Element();
    await Reflect.get(view, "renderCardSession").call(view, resumed, 0);
    expect(extraCalls()).toHaveLength(1);
    expect(resumed.all().filter(el => el.options.text === "补充")).toHaveLength(1);
  });
});
