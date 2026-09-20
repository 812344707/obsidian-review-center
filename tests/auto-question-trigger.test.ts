import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  ItemView: class {}, Modal: class {}, Notice: vi.fn(), Menu: class {}, setIcon: vi.fn(), MarkdownRenderer: {},
}));

import { ReviewCenterView } from "../src/view";
import { fixtureItem, fixtureSettings } from "./fixtures";

class Element {
  children: Element[] = [];
  handlers: Record<string, () => void> = {};
  disabled = false;
  constructor(readonly options: { text?: string; cls?: string } = {}) {}
  createEl(_tag: string, options = {}): Element { const child = new Element(options); this.children.push(child); return child; }
  createDiv(options = {}): Element { return this.createEl("div", options); }
  createSpan(options = {}): Element { return this.createEl("span", options); }
  addEventListener(type: string, handler: () => void): void { this.handlers[type] = handler; }
  querySelectorAll(): Element[] { return this.children; }
}

describe("automatic question rating trigger", () => {
  it("evaluates the generated bank after a successful card rating", async () => {
    const entry = {
      item: fixtureItem(), sourcePath: "自动题库/原文-自动题库.md", sourceTitle: "题库",
      sourceId: "bank", tags: ["#card"], group: fixtureSettings().cardGroups[0], isNew: true,
    };
    const gradeCurrent = vi.fn(async () => null);
    const handleAutoQuestionReview = vi.fn();
    const service = {
      maintenance: false,
      preview: () => ({ 1: { interval: "1 分钟" }, 2: { interval: "2 分钟" }, 3: { interval: "1 天" }, 4: { interval: "4 天" } }),
      gradeCurrent,
    };
    const view = new ReviewCenterView({} as never, { service, handleAutoQuestionReview } as never);
    vi.spyOn(view, "render").mockResolvedValue();
    const root = new Element();
    Reflect.get(view, "renderGrades").call(view, root, entry);
    root.children[0].children[0].handlers.click();
    await vi.waitFor(() => expect(handleAutoQuestionReview).toHaveBeenCalledWith(entry.sourcePath));
    expect(gradeCurrent).toHaveBeenCalledOnce();
    expect(view.render).toHaveBeenCalledOnce();
  });

  it("does not evaluate when the rating fails", async () => {
    const entry = {
      item: fixtureItem(), sourcePath: "自动题库/原文-自动题库.md", sourceTitle: "题库",
      sourceId: "bank", tags: ["#card"], group: fixtureSettings().cardGroups[0], isNew: true,
    };
    const handleAutoQuestionReview = vi.fn();
    const service = {
      maintenance: false,
      preview: () => ({ 1: { interval: "1 分钟" }, 2: { interval: "2 分钟" }, 3: { interval: "1 天" }, 4: { interval: "4 天" } }),
      gradeCurrent: vi.fn(async () => { throw new Error("failed"); }),
    };
    const view = new ReviewCenterView({} as never, { service, handleAutoQuestionReview } as never);
    vi.spyOn(view, "render").mockResolvedValue();
    const root = new Element();
    Reflect.get(view, "renderGrades").call(view, root, entry);
    root.children[0].children[0].handlers.click();
    await vi.waitFor(() => expect(view.render).toHaveBeenCalledOnce());
    expect(handleAutoQuestionReview).not.toHaveBeenCalled();
  });
});
