import { App, Modal, Setting } from "obsidian";
import { folderInput, TagInput } from "./inputs";
import { previewBulkTags, type BulkTagPreview, type BulkTagRequest, type BulkTagResult } from "./tags";
import type { ReviewCenterSettings } from "./types";

export interface BulkTagsHost {
  settings: ReviewCenterSettings;
  runBulkTags(request: BulkTagRequest, preview: BulkTagPreview[]): Promise<BulkTagResult[]>;
}

export class BulkTagsModal extends Modal {
  private request: BulkTagRequest = { target: "folder", folder: "", recursive: true, tags: [], match: "any", additions: [] };
  private preview: BulkTagPreview[] = [];
  private cleaners: Array<() => void> = [];
  private inputs: TagInput[] = [];
  constructor(app: App, private readonly host: BulkTagsHost) { super(app); }
  onOpen(): void { this.render(); }
  onClose(): void { this.clean(); this.contentEl.empty(); }
  private clean(): void { this.cleaners.forEach((fn) => fn()); this.cleaners = []; this.inputs = []; }

  private render(): void {
    this.clean();
    const root = this.contentEl;
    root.empty(); root.addClass("review-bulk-modal");
    root.createEl("h2", { text: "批量添加标签" });
    root.createEl("p", { text: "向文章的标签属性补充新标签，原有标签和正文保留。先预览，再选择需要处理的文章。" });
    const results = root.createDiv({ cls: "review-bulk-results" });
    let apply: HTMLButtonElement;
    const invalidate = () => { this.preview = []; results.empty(); if (apply) apply.disabled = true; };
    const controls = root.createDiv();
    new Setting(controls).setName("选择文章").addDropdown((dropdown) => dropdown
      .addOption("folder", "按文件夹").addOption("tags", "按标签集").setValue(this.request.target)
      .onChange((value) => { this.request.target = value as "folder" | "tags"; this.preview = []; this.render(); }));
    if (this.request.target === "folder") {
      new Setting(controls).setName("目标文件夹").setDesc("留空表示整个知识库。可输入或选择已有文件夹。").addText((text) => {
        text.setValue(this.request.folder).setPlaceholder("知识库根目录").onChange((value) => { this.request.folder = value; invalidate(); });
        const suggest = folderInput(this.app, text.inputEl, (value) => { this.request.folder = value; invalidate(); });
        this.cleaners.push(() => suggest.close());
      });
      new Setting(controls).setName("包含子文件夹").addToggle((toggle) => toggle.setValue(this.request.recursive).onChange((value) => { this.request.recursive = value; invalidate(); }));
    } else {
      const setting = new Setting(controls).setName("目标标签集").setDesc("自动包含所选标签的所有子标签。");
      this.addTags(setting.controlEl, this.request.tags, (tags) => { this.request.tags = tags; invalidate(); }, "目标标签");
      new Setting(controls).setName("匹配方式").addDropdown((dropdown) => dropdown.addOption("any", "满足任意一个").addOption("all", "同时满足全部")
        .setValue(this.request.match).onChange((value) => { this.request.match = value as "any" | "all"; invalidate(); }));
    }
    const additions = new Setting(controls).setName("额外添加的标签");
    this.addTags(additions.controlEl, this.request.additions, (tags) => { this.request.additions = tags; invalidate(); }, "新增标签");
    const error = controls.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    const actions = controls.createDiv({ cls: "review-center-modal-actions" });
    const previewButton = actions.createEl("button", { text: "预览匹配文章", cls: "mod-cta" });
    apply = actions.createEl("button", { text: "添加到选中文章" });
    apply.disabled = true;
    const busy = (value: boolean) => {
      controls.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach((el) => { el.disabled = value; });
      results.querySelectorAll<HTMLInputElement>("input").forEach((el) => { el.disabled = value; });
      if (!value) apply.disabled = !this.preview.some((entry) => entry.selected && !entry.error && entry.additions.length);
    };
    previewButton.addEventListener("click", () => void (async () => {
      try {
        this.inputs.forEach((input) => input.values());
        busy(true); error.empty(); results.empty();
        this.preview = await previewBulkTags(this.app, this.host.settings, this.request);
        const count = this.preview.filter((entry) => !entry.error && entry.additions.length).length;
        results.createEl("p", { text: "匹配 " + this.preview.length + " 篇，其中 " + count + " 篇需要添加标签。" });
        for (const entry of this.preview) {
          const row = results.createEl("label", { cls: "review-bulk-row" });
          const checkbox = row.createEl("input", { type: "checkbox", attr: { "aria-label": "选择 " + entry.path } });
          entry.selected = !entry.error && entry.additions.length > 0;
          checkbox.checked = entry.selected;
          checkbox.addEventListener("change", () => { entry.selected = checkbox.checked; apply.disabled = !this.preview.some((entry) => entry.selected); });
          const text = row.createDiv();
          text.createEl("strong", { text: entry.path });
          text.createEl("small", { text: entry.error ?? (entry.additions.length ? "将新增：" + entry.additions.map((tag) => "#" + tag).join("、") : "标签已齐全，无需修改") });
          if (entry.error || !entry.additions.length) checkbox.dataset.unavailable = "true";
        }
      } catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
      finally {
        busy(false);
        results.querySelectorAll<HTMLInputElement>('input[data-unavailable="true"]').forEach((el) => { el.disabled = true; });
      }
    })());
    apply.addEventListener("click", () => void (async () => {
      try {
        busy(true); error.setText("正在添加标签，请稍候…");
        const report = await this.host.runBulkTags(this.request, this.preview);
        this.preview = []; results.empty();
        const added = report.filter((entry) => entry.status === "added").length;
        const failed = report.filter((entry) => entry.status === "failed").length;
        error.setText("完成：已更新 " + added + " 篇，失败或需重新预览 " + failed + " 篇。");
        for (const entry of report) results.createEl("p", { text: entry.path + " — " + entry.message });
      } catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
      finally { busy(false); }
    })());
    root.append(results);
  }

  private addTags(parent: HTMLElement, initial: string[], changed: (tags: string[]) => void, label: string): void {
    const input = new TagInput(this.app, parent, initial, changed, label);
    this.inputs.push(input); this.cleaners.push(() => input.destroy());
  }
}
