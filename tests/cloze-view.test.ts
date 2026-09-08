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

describe("cloze answer blocks", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["第一行\n第二行", "第一段\n\n第二段", "- **第一条**\n- `第二条`"])(
    "reveals multiline clozes as intact Markdown blocks, including on resume: %s", async (markdown) => {
      const item = fixtureItem(); item.kind = "cloze"; item.clozeIndex = 1;
      item.content = { ...item.content, raw: `上下文 {{c1::${markdown}::提示}}，{{c2::其他空}}，{{c1::第二个答案}}。` };
      const entry = { item, sourcePath: "资料/笔记.md", sourceTitle: "笔记", tags: [], group: fixtureSettings().cardGroups[0] };
      const service = { currentEntry: () => entry, progress: () => ({ current: 1, total: 1 }), session: { answerVisible: false },
        setAnswerVisible: (value: boolean) => { service.session.answerVisible = value; }, canUndo: () => false };
      const view = new ReviewCenterView({} as never, { service } as never);
      const grades = vi.fn(); Reflect.set(view, "renderGrades", grades);
      const root = new Element();
      await Reflect.get(view, "renderCardSession").call(view, root, 0);
      const calls = () => vi.mocked(MarkdownRenderer.render).mock.calls;
      expect(calls().map(call => call[1])).toEqual(["上下文 ==提示==，其他空，==\u2060==。"]);
      root.all().find(el => el.options.text === "显示答案")!.handlers.click();
      await vi.waitFor(() => expect(grades).toHaveBeenCalledOnce());
      expect(calls().slice(1).map(call => call[1])).toEqual([markdown, "第二个答案"]);
      expect(calls().every(call => call[3] === entry.sourcePath)).toBe(true);
      expect(root.all().filter(el => el.options.text === "答案")).toHaveLength(1);
      vi.mocked(MarkdownRenderer.render).mockClear();
      const resumed = new Element();
      await Reflect.get(view, "renderCardSession").call(view, resumed, 0);
      expect(calls().map(call => call[1])).toEqual(["上下文 ==提示==，其他空，==\u2060==。", markdown, "第二个答案"]);
      expect(resumed.all().filter(el => el.options.text === "答案")).toHaveLength(1);
    },
  );
});
