import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Component: class { register() {} },
  Platform: { isMobile: false },
  setIcon: vi.fn(),
}));

import { ReviewOverlay } from "../src/overlay";

class Element {
  children: Element[] = [];
  onclick?: () => void;
  onpointerdown?: (event: { preventDefault(): void }) => void;
  style = { setProperty: vi.fn() };
  constructor(readonly tag = "div", readonly options: { text?: string; attr?: Record<string, string> } = {}) {}
  createEl(tag: string, options = {}) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  addEventListener() {}
  addClass() {}
  removeClass() {}
  toggleClass() {}
  prepend() {}
  remove() {}
  empty() { this.children = []; }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
}

function harness(mode: "note" | "exercise") {
  const body = new Element("body");
  const doc = {
    body,
    activeElement: null,
    defaultView: { setTimeout: vi.fn(), innerHeight: 800, visualViewport: null },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const path = mode === "exercise" ? "习题/测试.md" : "资料/原文.md";
  const author = vi.fn(async () => {}), choose = vi.fn(), create = vi.fn(async () => {});
  const host = {
    getOverlayEntry: () => mode === "note" ? { sourcePath: path, sourceTitle: "原文" } : null,
    getOverlayMode: () => mode,
    getExercisePagePath: () => mode === "exercise" ? path : null,
    previewCurrent: () => ({ 1: { interval: "1分" }, 2: { interval: "1天" }, 3: { interval: "2天" }, 4: { interval: "4天" } }),
    gradeActiveNote: vi.fn(async () => {}), canUndoReview: () => false, undoActiveNote: vi.fn(async () => {}),
    returnToReview: vi.fn(async () => {}), exitReview: vi.fn(async () => {}), captureCardSelection: vi.fn(),
    chooseCardTemplate: choose, authorCurrentNote: author, createExercisePage: create,
  };
  const leaf = {
    view: { file: { path }, containerEl: { doc, isConnected: true }, getViewType: () => "markdown" },
    getViewState: () => ({ type: "markdown", state: { file: path } }),
  };
  const overlay = new ReviewOverlay(host as never); overlay.sync(leaf as never);
  const buttons = body.all().filter((element) => element.tag === "button");
  return { buttons, author, choose, create };
}

describe("exercise page authoring toolbar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the three existing card actions on a reopened exercise page", () => {
    const h = harness("exercise");
    expect(h.buttons.map((button) => button.options.attr?.["data-author-card"])).toEqual(["review", "qa", "cloze"]);
    h.buttons[0].onclick?.(); h.buttons[1].onclick?.();
    expect(h.choose).toHaveBeenCalledOnce();
    expect(h.author).toHaveBeenCalledWith("qa");
  });

  it("adds the exercise page action to the note review footer", () => {
    const h = harness("note");
    const button = h.buttons.find((candidate) => candidate.options.attr?.["data-author-card"] === "exercise");
    expect(button?.options.text).toBe("习题页");
    button?.onclick?.();
    expect(h.create).toHaveBeenCalledOnce();
  });
});
