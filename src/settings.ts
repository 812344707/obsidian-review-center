import { App, PluginSettingTab, Setting } from "obsidian";
import { createGroup, groupsFor } from "./config";
import type { ReviewCenterSettings, ReviewGroup, ReviewMode } from "./types";
import { cloneValue, createId } from "./utils";
import { folderInput } from "./inputs";
import { BulkTagsModal } from "./bulk-tags-modal";
import type ReviewCenterPlugin from "./main";
import { renderRecognitionEditor } from "./recognition-editor";
export { DEFAULT_SETTINGS } from "./config";

const TABS = [["groups", "复习分组"], ["notes", "笔记识别"], ["cards", "卡片识别"], ["data", "数据与备份"], ["display", "显示"]] as const;
type SettingsPage = typeof TABS[number][0];
type DisplayDraft = Pick<ReviewCenterSettings, "showNoteHeatmap" | "showCardHeatmap" | "autoOpenDashboard">;

export class ReviewCenterSettingTab extends PluginSettingTab {
  private page: SettingsPage = "groups";
  private mode: ReviewMode = "note";
  private selected: Partial<Record<ReviewMode, string>> = {};
  private cleaners: Array<() => void> = [];
  private folderDraft?: string;
  private displayDraft?: DisplayDraft;
  private migrating = false;
  constructor(app: App, private readonly host: ReviewCenterPlugin) { super(app, host); }
  showRecognition(mode: ReviewMode): void { this.page = mode === "note" ? "notes" : "cards"; this.mode = mode; this.display(); }
  hide(): void { this.clean(); }
  private clean(): void {
    this.cleaners.forEach((clean) => clean()); this.cleaners = [];
    this.host.optionsWorkspace.dispose();
  }

  display(): void {
    this.clean();
    const root = this.containerEl;
    root.empty(); root.addClass("review-center-settings");
    const tabs = root.createDiv({ cls: "review-settings-tabs", attr: { role: "tablist", "aria-label": "渐进式复习设置分类" } });
    TABS.forEach(([id, label], index) => {
      const button = tabs.createEl("button", { text: label, cls: this.page === id ? "is-active" : "", attr: {
        type: "button", role: "tab", id: "review-settings-tab-" + id, "aria-selected": String(this.page === id),
        "aria-controls": "review-settings-panel", tabindex: this.page === id ? "0" : "-1",
      } });
      const select = (next: SettingsPage) => {
        this.page = next; this.display();
        const active = root.querySelector<HTMLElement>("#review-settings-tab-" + next);
        active?.focus({ preventScroll: true }); active?.scrollIntoView({ block: "nearest", inline: "nearest" });
      };
      button.onclick = () => select(id);
      button.onkeydown = (event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); select(TABS[next][0]); }
      };
    });
    const panel = root.createDiv({ cls: "review-settings-panel", attr: { role: "tabpanel", id: "review-settings-panel", "aria-labelledby": "review-settings-tab-" + this.page } });
    if (this.page === "groups") this.renderGroups(panel);
    else if (this.page === "notes" || this.page === "cards") this.renderRecognition(panel, this.page === "notes" ? "note" : "card");
    else if (this.page === "data") this.renderData(panel);
    else this.renderDisplay(panel);
  }

  private renderGroups(root: HTMLElement): void {
    root.createEl("p", { cls: "review-settings-intro", text: "管理复习组名称和优先级；文件夹、标签条件分别在“笔记识别”“卡片识别”中设置。每日上限、学习步长等参数在主页齿轮 → 选项中设置。" });
    const selector = new Setting(root).setName("复习组");
    selector.addDropdown((d) => d.addOption("note", "笔记复习").addOption("card", "卡片复习").setValue(this.mode)
      .onChange((value) => { this.mode = value as ReviewMode; this.display(); }));
    const workspace = this.host.optionsWorkspace;
    const groups = groupsFor(workspace.draft, this.mode);
    const group = groups.find((entry) => entry.id === this.selected[this.mode]) ?? groups[0];
    if (group) this.selected[this.mode] = group.id;
    selector.addDropdown((d) => {
      if (!groups.length) d.addOption("", "暂无复习组");
      groups.forEach((entry) => d.addOption(entry.id, entry.name));
      d.setValue(group?.id ?? "").onChange((value) => { this.selected[this.mode] = value; this.display(); });
    });
    selector.addDropdown((d) => d.addOption("", "管理复习组…")
      .addOption("new", "新增").addOption("copy", "复制当前组").addOption("up", "上移优先级").addOption("down", "下移优先级").addOption("delete", "删除当前组")
      .onChange((value) => { if (value) this.manage(value, group); }));
    if (group) {
      const editor = root.createDiv({ cls: "review-group-editor" }); editor.toggleClass("is-card", this.mode === "card");
      workspace.renderGroupFields(editor, { mode: this.mode, groupId: group.id });
    }
    else root.createEl("p", { text: "从“管理复习组”新增一组，再设置识别范围。" });
    this.saveRow(root, "保存复习分组", "切换分类、模式或组保留草稿。保存应用已编辑的组及共享预设；删除组保留原文和复习进度。",
      () => workspace.save(), () => workspace.reset());
    new Setting(root).setName("批量纳入文章").setDesc("按文件夹或标签集筛选文章，预览后补充复习标签。")
      .addButton((b) => b.setButtonText("批量添加标签").onClick(() => new BulkTagsModal(this.app, this.host).open()));
  }

  private renderRecognition(root: HTMLElement, mode: ReviewMode): void {
    this.mode = mode;
    root.createEl("p", { cls: "review-settings-intro", text: mode === "note" ? "笔记识别：条件匹配的整篇文章进入笔记复习，无需复习块。" : "卡片识别：先按以下条件选文章，再识别其中 [!review] 块里的问答和填空。与笔记范围独立。" });
    const workspace = this.host.optionsWorkspace, groups = groupsFor(workspace.draft, mode);
    const group = groups.find((g) => g.id === this.selected[mode]) ?? groups[0];
    if (group) this.selected[mode] = group.id;
    new Setting(root).setName("识别到复习组").addDropdown((d) => {
      if (!groups.length) d.addOption("", "请先新增复习组");
      for (const g of groups) d.addOption(g.id, g.name);
      d.setValue(group?.id ?? "").onChange((v) => { this.selected[mode] = v; this.display(); });
    });
    if (group) renderRecognitionEditor(this.app, root, group, () => this.display(), (clean) => this.cleaners.push(clean));
    this.saveRow(root, mode === "note" ? "保存笔记识别" : "保存卡片识别", "保存后点击主页“整理数据”更新清单；切换页面保留草稿，移出范围保留进度。", () => workspace.save(), () => workspace.reset());
    if (mode === "card") root.createEl("pre", { cls: "review-callout-example", text: "> [!review]- 复习\n> 问:: 这一节的核心观点是什么？\n> 答:: 这里填写答案。\n\n> [!review]- 填空\n> 需要记住{{c1::这段文字}}。" });
    new Setting(root).setName("识别与内容异常").setDesc("查看问题原因和对应处理办法；修正后重新检查。")
      .addButton((b) => b.setButtonText("查看待处理内容").onClick(() => this.openManagement()));
  }

  private renderData(root: HTMLElement): void {
    const message = root.createDiv({ cls: "review-setting-error", attr: { role: "status" } });
    this.folderDraft ??= this.host.settings.dataFolder;
    new Setting(root).setName("复习数据目录").setDesc("知识库内的相对路径。输入不会切换目录；应用时复制并核对数据，旧目录保留为备份。")
      .addText((t) => {
        t.setValue(this.folderDraft!).onChange((v) => { this.folderDraft = v; });
        const suggest = folderInput(this.app, t.inputEl, (v) => { this.folderDraft = v; });
        this.cleaners.push(() => suggest.close());
      }).addButton((b) => b.setButtonText("应用并迁移").setDisabled(this.migrating).onClick(() => void (async () => {
        if (this.migrating) return;
        this.migrating = true; b.setDisabled(true); message.setText("正在核对和迁移，请稍候…");
        try {
          await this.host.migrateDataFolder(this.folderDraft!); this.folderDraft = this.host.settings.dataFolder;
          message.setText("当前目录：" + this.folderDraft + "。旧目录继续保留。");
        } catch (error) { message.setText(String(error)); }
        finally { this.migrating = false; b.setDisabled(false); }
      })()));
    new Setting(root).setName("内容与备份").setDesc("管理暂停、记忆难点、内容变更，以及导出和恢复备份。")
      .addButton((b) => b.setButtonText("打开管理").onClick(() => this.openManagement()));
    new Setting(root).setName("中断的批量操作").setDesc("查看标签修改和重新排程的备份与进度，继续未完成的操作。")
      .addButton((b) => b.setButtonText("查看操作记录").onClick(() => this.host.openOperationHistory()));
  }

  private renderDisplay(root: HTMLElement): void {
    this.displayDraft ??= this.currentDisplay();
    for (const [key, name, desc] of [
      ["showNoteHeatmap", "笔记热力图", "在统计页显示每天给笔记评分的次数。"],
      ["showCardHeatmap", "卡片热力图", "在统计页显示每天给卡片评分的次数。"],
      ["autoOpenDashboard", "启动时打开渐进式复习", "打开知识库后自动显示复习首页。"],
    ] as const) {
      new Setting(root).setName(name).setDesc(desc).addToggle((t) => t.setValue(this.displayDraft![key])
        .onChange((v) => { this.displayDraft![key] = v; }));
    }
    this.saveRow(root, "保存显示设置", "切换标签页保留草稿，保存后生效。", () => this.patch(this.displayDraft!), () => { this.displayDraft = this.currentDisplay(); });
  }

  private currentDisplay(): DisplayDraft {
    const { showNoteHeatmap, showCardHeatmap, autoOpenDashboard } = this.host.settings;
    return { showNoteHeatmap, showCardHeatmap, autoOpenDashboard };
  }
  private saveRow(root: HTMLElement, title: string, description: string, save: () => Promise<void>, reset: () => void): void {
    const error = root.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    const row = new Setting(root).setName(title).setDesc(description);
    row.addButton((b) => b.setButtonText("还原草稿").onClick(() => { reset(); this.display(); }));
    row.addButton((b) => b.setButtonText("保存").setCta().onClick(() => {
      b.setDisabled(true);
      void Promise.resolve().then(save).then(() => {
        this.display();
        this.containerEl.createDiv({ cls: "review-settings-saved", text: title + "已完成", attr: { role: "status" } });
      })
        .catch((e) => { error.setText(e instanceof Error ? e.message : String(e)); })
        // Obsidian components are thenable; returning one makes Promise assimilation loop.
        .finally(() => { b.setDisabled(false); });
    }));
  }
  private openManagement(): void { this.host.closePluginSettings(); void this.host.openManagement(); }
  private manage(action: string, group?: ReviewGroup): void {
    const groups = [...groupsFor(this.host.optionsWorkspace.draft, this.mode)];
    if (action === "new" || (action === "copy" && group)) {
      const next = action === "new" ? createGroup(this.mode) : { ...cloneValue(group!), id: createId("group"), name: group!.name + " 副本" };
      next.presetId = createId("preset"); next.nodes = {};
      (this.host.optionsWorkspace.draft.presets ??= []).push({ id: next.presetId, mode: this.mode, name: next.name, parameters: cloneValue(next.parameters) });
      groups.push(next); this.selected[this.mode] = next.id;
    } else if (group) {
      const index = groups.findIndex((entry) => entry.id === group.id);
      if (action === "delete") groups.splice(index, 1);
      else {
        const other = index + (action === "up" ? -1 : 1);
        if (other >= 0 && other < groups.length) [groups[index], groups[other]] = [groups[other], groups[index]];
      }
    }
    if (this.mode === "note") this.host.optionsWorkspace.draft.noteGroups = groups; else this.host.optionsWorkspace.draft.cardGroups = groups;
    this.display();
  }
  private async patch(patch: Partial<ReviewCenterSettings>): Promise<void> { await this.host.updateSettings({ ...this.host.settings, ...patch }); }
}
