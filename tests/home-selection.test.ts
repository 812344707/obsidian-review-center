import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ ItemView: class {}, Modal: class {}, Notice: vi.fn(), Menu: class {}, setIcon: vi.fn(), MarkdownRenderer: {} }));
import { ReviewCenterView } from "../src/view";
import { setReviewTags } from "../src/tag-groups";
import { fixtureRecord, fixtureSettings } from "./fixtures";

// Exercise the actual homepage click handlers without an Obsidian renderer.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style = { setProperty: vi.fn() };
  scrollTop = 0;
  onclick?: () => void;
  onkeydown?: (event: unknown) => void;
  constructor(readonly tag: string, readonly options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {}
  createEl(tag: string, options = {}): Element { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options = {}): Element { return this.createEl("div", options); }
  createSpan(options = {}): Element { return this.createEl("span", options); }
  setAttribute(key: string, value: string): void { (this.options.attr ??= {})[key] = value; }
  addClass() {} removeClass() {}
  all(): Element[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(): Element[] { return this.all().filter((el) => el.options.attr?.role === "row" && "aria-selected" in el.options.attr); }
}

describe("starting from the selected homepage tag", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["note", "card"] as const)("uses the latest clicked or keyboard-selected %s tag without needing a rerender", (mode) => {
    const settings = fixtureSettings();
    setReviewTags(settings, mode, [mode, "医学"]);
    const groups = mode === "note" ? settings.noteGroups : settings.cardGroups, second = groups[1];
    const startReview = vi.fn(), plugin = { settings, startReview, service: {
      records: [fixtureRecord("first", [mode]), fixtureRecord("second", ["医学/伤寒"])],
      counts: () => ({ new: 1, learning: 0, review: 0, due: 0 }), pendingChanges: () => [],
    } };
    const view = new ReviewCenterView({} as never, plugin as never);
    Reflect.set(view, "homeMode", mode);
    vi.spyOn(view as unknown as { saveHome(): void }, "saveHome").mockImplementation(() => {});
    vi.spyOn(view, "updateStartState").mockImplementation(() => {});
    vi.spyOn(view, "updatePreparationState").mockImplementation(() => {});
    const root = new Element("div");
    Reflect.get(view, "renderHome").call(view, root);
    const start = root.all().find((el) => el.options.text === "开始")!;
    const rows = root.querySelectorAll();
    const row = (label: string) => rows.find((el) => el.all().some((child) => child.tag === "span" && child.options.text === label))!;
    row("#医学").onclick!(); start.onclick!();
    expect(startReview).toHaveBeenLastCalledWith(mode, false, second.id, undefined);
    row("伤寒").onkeydown!({ target: row("伤寒"), key: "Enter", preventDefault: vi.fn() }); start.onclick!();
    expect(startReview).toHaveBeenLastCalledWith(mode, false, second.id, "医学/伤寒");
    row("#" + mode).onclick!(); start.onclick!();
    expect(startReview).toHaveBeenLastCalledWith(mode, false, groups[0].id, undefined);
  });
});
