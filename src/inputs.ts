import { AbstractInputSuggest, TFolder, type App } from "obsidian";
import { collectVaultTags } from "./tags";
import { parseTags } from "./config";

class TextSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, input: HTMLInputElement, private readonly items: () => string[], private readonly choose: (value: string) => void, private readonly tag = false) {
    super(app, input);
    this.limit = 20;
  }
  protected getSuggestions(query: string): string[] {
    const needle = query.replace(/^#/, "").trim().toLowerCase();
    return this.items().filter((value) => value.toLowerCase().includes(needle)).sort((a, b) =>
      Number(!a.startsWith(needle)) - Number(!b.startsWith(needle)) || a.localeCompare(b, "zh-CN")).slice(0, 20);
  }
  renderSuggestion(value: string, el: HTMLElement): void { el.setText((this.tag ? "#" : "") + value); }
  selectSuggestion(value: string): void { this.choose(value); this.close(); }
}

export function folderInput(app: App, input: HTMLInputElement, changed: (value: string) => void): TextSuggest {
  return new TextSuggest(app, input, () => app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && file.path !== "/").map((file) => file.path),
    (value) => { input.value = value; changed(value); });
}

export function tagInput(app: App, input: HTMLInputElement, changed: (value: string) => void): TextSuggest {
  return new TextSuggest(app, input, () => collectVaultTags(app), (value) => { input.value = value; changed(value); }, true);
}

export class TagInput {
  readonly input: HTMLInputElement;
  private readonly chips: HTMLElement;
  private readonly error: HTMLElement;
  private readonly suggest: TextSuggest;
  private tags: string[];
  constructor(app: App, parent: HTMLElement, initial: string[], private readonly changed: (tags: string[]) => void, label = "标签") {
    this.tags = [...initial];
    const root = parent.createDiv({ cls: "review-tag-input" });
    this.chips = root.createDiv({ cls: "review-tag-chips" });
    const row = root.createDiv({ cls: "review-tag-entry" });
    this.input = row.createEl("input", { type: "text", placeholder: "输入标签，选择或按回车", attr: { "aria-label": label } });
    const add = row.createEl("button", { text: "添加", attr: { "aria-label": "添加" + label } });
    this.error = root.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    this.suggest = new TextSuggest(app, this.input, () => collectVaultTags(app).filter((tag) => !this.tags.includes(tag)),
      (value) => { try { this.add(value); } catch { /* Inline error is shown. */ } }, true);
    add.addEventListener("click", () => { try { this.commit(); } catch { /* Inline error is shown. */ } });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault(); try { this.commit(); } catch { /* Inline error is shown. */ }
      }
    });
    this.renderChips();
  }
  commit(): void {
    if (this.input.value.trim()) this.add(this.input.value);
  }
  values(): string[] { this.commit(); return [...this.tags]; }
  destroy(): void { this.suggest.close(); }
  private add(value: string): void {
    try {
      const values = parseTags(value);
      this.tags = [...new Set([...this.tags, ...values])];
      this.input.value = ""; this.error.empty();
      this.renderChips(); this.changed([...this.tags]);
    } catch (error) {
      this.error.setText(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  private renderChips(): void {
    this.chips.empty();
    for (const tag of this.tags) {
      const chip = this.chips.createSpan({ cls: "review-tag-chip" });
      chip.createSpan({ text: "#" + tag });
      const remove = chip.createEl("button", { text: "×", attr: { "aria-label": "移除标签 " + tag } });
      remove.addEventListener("click", () => { this.tags = this.tags.filter((value) => value !== tag); this.renderChips(); this.changed([...this.tags]); });
    }
  }
}
