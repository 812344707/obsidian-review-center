import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { createGroup, groupsFor, parseCalloutTypes, parseSteps } from "./config";
import type { ReviewCenterSettings, ReviewGroup, ReviewMode, ReviewParameters } from "./types";
import { cloneValue, createId } from "./utils";
import { folderInput, TagInput } from "./inputs";
import { BulkTagsModal, type BulkTagsHost } from "./bulk-tags-modal";
export { DEFAULT_SETTINGS } from "./config";

type SettingsHost = Plugin & BulkTagsHost & {
  settings: ReviewCenterSettings;
  updateSettings(next: ReviewCenterSettings): Promise<void>;
  migrateDataFolder(path: string): Promise<void>;
};
interface GroupDraft { group: ReviewGroup; values: Record<keyof ReviewParameters, string>; tagText?: string }

export class ReviewCenterSettingTab extends PluginSettingTab {
  private mode: ReviewMode = "note";
  private selected: Partial<Record<ReviewMode, string>> = {};
  private drafts = new Map<string, GroupDraft>();
  private cleaners: Array<() => void> = [];
  private folderDraft?: string;
  constructor(app: App, private readonly host: SettingsHost) { super(app, host); }
  hide(): void { this.clean(); }
  private clean(): void { this.cleaners.forEach((clean) => clean()); this.cleaners = []; }

  display(): void {
    this.clean();
    const root = this.containerEl;
    root.empty(); root.addClass("review-center-settings");
    root.createEl("p", { cls: "review-settings-intro", text: "按文章标签纳入复习。卡片继承文章标签；选择父标签会自动包含子标签。" });
    const selector = new Setting(root).setName("复习组");
    selector.addDropdown((dropdown) => dropdown.addOption("note", "笔记复习").addOption("card", "卡片复习").setValue(this.mode)
      .onChange((value) => { this.mode = value as ReviewMode; this.display(); }));
    const groups = groupsFor(this.host.settings, this.mode);
    const group = groups.find((entry) => entry.id === this.selected[this.mode]) ?? groups[0];
    if (group) this.selected[this.mode] = group.id;
    selector.addDropdown((dropdown) => {
      if (!groups.length) dropdown.addOption("", "暂无复习组");
      groups.forEach((entry) => dropdown.addOption(entry.id, entry.name));
      dropdown.setValue(group?.id ?? "").onChange((value) => { this.selected[this.mode] = value; this.display(); });
    });
    selector.addDropdown((dropdown) => dropdown.addOption("", "管理复习组…")
      .addOption("new", "新增").addOption("copy", "复制当前组").addOption("up", "上移优先级").addOption("down", "下移优先级").addOption("delete", "删除当前组")
      .onChange((value) => { if (value) void this.manage(value, group).catch((error) => new Notice(String(error))); }));
    if (group) this.renderGroup(group);
    new Setting(root).setName("批量纳入文章").setDesc("按文件夹或标签集筛选文章，预览后补充复习标签。")
      .addButton((button) => button.setButtonText("批量添加标签").onClick(() => new BulkTagsModal(this.app, this.host).open()));

    new Setting(root).setName("复习块").setHeading();
    root.createEl("p", { text: "默认识别 [!review]。标题可自由修改；每篇可有多个块，问答和挖空都写在块内。" });
    const sample = root.createEl("pre", { cls: "review-callout-example" });
    sample.setText("> [!review]- 复习\n> 问:: 这一节的核心观点是什么？\n> 答:: 这里填写答案。");
    let types = this.host.settings.reviewCalloutTypes.filter((type) => type !== "review").join(" ");
    const typeError = root.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    new Setting(root).setName("额外识别的提示块类型").setDesc("例如 study-card；多个类型用空格分隔。默认 review 始终可用。")
      .addText((text) => text.setValue(types).setPlaceholder("study-card learn").onChange((value) => { types = value; }))
      .addButton((button) => button.setButtonText("保存类型").onClick(() => void (async () => {
        try { await this.patch({ reviewCalloutTypes: parseCalloutTypes(types) }); typeError.empty(); new Notice("复习块类型已保存"); }
        catch (error) { typeError.setText(error instanceof Error ? error.message : String(error)); }
      })()));

    new Setting(root).setName("数据与显示").setHeading();
    const dataMessage = root.createDiv({ cls: "review-setting-error", attr: { role: "status" } });
    this.folderDraft ??= this.host.settings.dataFolder;
    new Setting(root).setName("复习数据目录").setDesc("知识库内的相对路径。可输入新目录；应用时自动复制并核对数据，旧目录保留为备份。")
      .addText((text) => {
        text.setValue(this.folderDraft!).onChange((value) => { this.folderDraft = value; });
        const suggest = folderInput(this.app, text.inputEl, (value) => { this.folderDraft = value; });
        this.cleaners.push(() => suggest.close());
      }).addButton((button) => button.setButtonText("应用并迁移").onClick(() => void (async () => {
        button.setDisabled(true); dataMessage.setText("正在核对和迁移，请稍候…");
        try {
          await this.host.migrateDataFolder(this.folderDraft!);
          this.folderDraft = this.host.settings.dataFolder;
          dataMessage.setText("当前目录：" + this.folderDraft + "。迁移完成后，旧目录继续保留。");
        } catch (error) { dataMessage.setText(error instanceof Error ? error.message : String(error)); }
        finally { button.setDisabled(false); }
      })()));
    for (const [key, name, desc] of [
      ["showNoteHeatmap", "笔记热力图", "在首页显示每天给笔记评分的次数。"],
      ["showCardHeatmap", "卡片热力图", "在首页显示每天给卡片评分的次数。"],
      ["autoOpenDashboard", "启动时打开复习中心", "打开知识库后自动显示复习首页。"],
    ] as const) {
      new Setting(root).setName(name).setDesc(desc).addToggle((toggle) => toggle.setValue(this.host.settings[key])
        .onChange((value) => void this.patch({ [key]: value }).catch((error) => new Notice(String(error)))));
    }
  }

  private draftFor(group: ReviewGroup): GroupDraft {
    let draft = this.drafts.get(group.id);
    if (!draft) {
      draft = { group: cloneValue(group), values: {
        newLimit: String(group.parameters.newLimit), reviewLimit: String(group.parameters.reviewLimit),
        retention: String(Math.round(group.parameters.retention * 100)), maximumInterval: String(group.parameters.maximumInterval),
        learningSteps: group.parameters.learningSteps.join(" "), relearningSteps: group.parameters.relearningSteps.join(" "),
      } };
      this.drafts.set(group.id, draft);
    }
    return draft;
  }

  private renderGroup(group: ReviewGroup): void {
    const draft = this.draftFor(group);
    const root = this.containerEl.createDiv({ cls: "review-group-editor is-" + this.mode });
    new Setting(root).setName("组名称").addText((text) => text.setValue(draft.group.name).onChange((value) => { draft.group.name = value; }));
    const tags = new Setting(root).setName("标签集").setDesc("匹配任意一个，包含子标签。空标签集不纳入文章。");
    const input = new TagInput(this.app, tags.controlEl, draft.group.tags, (values) => { draft.group.tags = values; draft.tagText = ""; }, "复习组标签");
    input.input.value = draft.tagText ?? "";
    input.input.addEventListener("input", () => { draft.tagText = input.input.value; });
    this.cleaners.push(() => input.destroy());
    const unit = this.mode === "note" ? "篇" : "张";
    const numeric = (parent: HTMLElement, name: string, key: "newLimit" | "reviewLimit" | "retention" | "maximumInterval", min: number, max: number, desc: string) => {
      new Setting(parent).setName(name).setDesc(desc).addText((text) => {
        text.setValue(draft.values[key]).onChange((value) => { draft.values[key] = value; });
        text.inputEl.type = "number"; text.inputEl.min = String(min); text.inputEl.max = String(max); text.inputEl.step = "1";
      });
    };
    numeric(root, "每日新内容（" + unit + "）", "newLimit", 0, this.mode === "note" ? 999 : 9999, "每天最多开始学习多少" + unit + "新内容；0 表示暂不学习新内容。");
    numeric(root, "每日到期复习（" + unit + "）", "reviewLimit", 0, this.mode === "note" ? 9999 : 99999, "每天最多复习多少项到期内容，同一项当天重复练习只占一次额度。");
    numeric(root, "目标记忆率（%）", "retention", 70, 99, "希望下次复习时仍能记住的比例；调高通常需要更频繁地复习。");
    const advanced = root.createEl("details", { cls: "review-advanced" });
    advanced.createEl("summary", { text: "更多参数" });
    for (const [key, name, desc] of [
      ["learningSteps", "学习步长", "新内容第一次学习后，隔多久再练习。例如 1m 10m 表示 1 分钟、10 分钟。"],
      ["relearningSteps", "重学步长", "已学内容选择“重来”后，隔多久再次练习。例如 10m 表示 10 分钟。"],
    ] as const) new Setting(advanced).setName(name).setDesc(desc + " m 为分钟，h 为小时；留空交给系统安排。")
      .addText((text) => text.setValue(draft.values[key]).onChange((value) => { draft.values[key] = value; }));
    numeric(advanced, "最大间隔（天）", "maximumInterval", 1, 36500, "两次复习之间最长允许隔多少天。");
    const error = root.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    new Setting(root).setName("保存本组").setDesc("新参数从下一次评分生效。切换组会保留未保存的草稿。")
      .addButton((button) => button.setButtonText("还原修改").onClick(() => { this.drafts.delete(group.id); this.display(); }))
      .addButton((button) => button.setButtonText("保存").setCta().onClick(() => void (async () => {
        try {
          draft.group.tags = input.values();
          if (!draft.group.name.trim()) throw new Error("请输入组名称。");
          for (const [key, min, max] of [
            ["newLimit", 0, this.mode === "note" ? 999 : 9999], ["reviewLimit", 0, this.mode === "note" ? 9999 : 99999],
            ["retention", 70, 99], ["maximumInterval", 1, 36500],
          ] as const) {
            const value = Number(draft.values[key]);
            if (!draft.values[key].trim() || !Number.isInteger(value) || value < min || value > max) throw new Error("请检查数值：须在输入框标注范围内，且为整数。");
            draft.group.parameters[key] = key === "retention" ? value / 100 : value;
          }
          draft.group.parameters.learningSteps = parseSteps(draft.values.learningSteps);
          draft.group.parameters.relearningSteps = parseSteps(draft.values.relearningSteps);
          await this.saveGroups(groupsFor(this.host.settings, this.mode).map((entry) => entry.id === group.id ? draft.group : entry));
          this.drafts.delete(group.id); this.display(); new Notice("复习组已保存");
        } catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
      })()));
  }

  private async manage(action: string, group?: ReviewGroup): Promise<void> {
    const groups = [...groupsFor(this.host.settings, this.mode)];
    if (action === "new" || (action === "copy" && group)) {
      const next = action === "new" ? createGroup(this.mode) : { ...cloneValue(group!), id: createId("group"), name: group!.name + " 副本" };
      groups.push(next); this.selected[this.mode] = next.id;
    } else if (group) {
      const index = groups.findIndex((entry) => entry.id === group.id);
      if (action === "delete") { groups.splice(index, 1); this.drafts.delete(group.id); }
      else {
        const other = index + (action === "up" ? -1 : 1);
        if (other >= 0 && other < groups.length) [groups[index], groups[other]] = [groups[other], groups[index]];
      }
    }
    await this.saveGroups(groups); this.display();
  }
  private async saveGroups(groups: ReviewGroup[]): Promise<void> { await this.patch(this.mode === "note" ? { noteGroups: groups } : { cardGroups: groups }); }
  private async patch(patch: Partial<ReviewCenterSettings>): Promise<void> { await this.host.updateSettings({ ...this.host.settings, ...patch }); }
}
