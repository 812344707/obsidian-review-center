import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { createGroup, groupsFor, parseSteps, parseTags } from "./config";
import type { ReviewCenterSettings, ReviewGroup, ReviewMode, ReviewParameters } from "./types";
import { cloneValue, createId } from "./utils";
export { DEFAULT_SETTINGS } from "./config";

type SettingsHost = Plugin & {
  settings: ReviewCenterSettings;
  updateSettings(next: ReviewCenterSettings): Promise<void>;
};

export class ReviewCenterSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost) { super(app, host); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("review-center-settings");
    containerEl.createEl("p", { text: "按笔记标签纳入复习，卡片继承来源笔记标签。每组匹配任意一个标签，并包含其下级标签；更具体的标签优先，同层级按组顺序。标签为空时不纳入内容。" });
    this.renderGroups("note");
    this.renderGroups("card");

    new Setting(containerEl).setName("主页显示").setHeading();
    for (const [key, name] of [["showNoteHeatmap", "显示笔记复习热力图"], ["showCardHeatmap", "显示卡片复习热力图"], ["autoOpenDashboard", "启动时打开复习中心"]] as const) {
      new Setting(containerEl).setName(name).addToggle((toggle) => toggle.setValue(this.host.settings[key]).onChange(async (value) => this.patch({ [key]: value })));
    }
    new Setting(containerEl).setName("内容与同步").setHeading();
    new Setting(containerEl).setName("复习章节标题").setDesc("每篇笔记由您手动创建，卡片只在这个章节内识别。")
      .addText((text) => text.setValue(this.host.settings.reviewHeading).onChange(async (value) => {
        const heading = value.replace(/^#+\s*/, "").trim();
        if (heading) await this.patch({ reviewHeading: heading });
      }))
      .addDropdown((dropdown) => {
        for (let level = 1; level <= 6; level += 1) dropdown.addOption(String(level), `${"#".repeat(level)} 标题 ${level}`);
        dropdown.setValue(String(this.host.settings.reviewHeadingLevel)).onChange(async (value) => this.patch({ reviewHeadingLevel: Number(value) }));
      });
    new Setting(containerEl).setName("同步数据文件夹").setDesc("更改目录不会搬迁旧数据。请先导出备份，在新目录恢复；Obsidian Sync 需同步其他文件类型。")
      .addText((text) => text.setValue(this.host.settings.dataFolder).onChange(async (value) => {
        const path = value.replace(/^\/+|\/+$/g, "").trim();
        if (path && !path.split("/").some((part) => part === "." || part === "..")) await this.patch({ dataFolder: path });
      }));
  }

  private renderGroups(mode: ReviewMode): void {
    const groups = groupsFor(this.host.settings, mode);
    new Setting(this.containerEl).setName(mode === "note" ? "笔记复习组" : "卡片复习组").setHeading()
      .addButton((button) => button.setButtonText("新增复习组").onClick(async () => {
        await this.saveGroups(mode, [...groupsFor(this.host.settings, mode), createGroup(mode)]);
        this.display();
      }));
    groups.forEach((group, index) => this.renderGroup(mode, group, index));
  }

  private renderGroup(mode: ReviewMode, group: ReviewGroup, index: number): void {
    const section = this.containerEl.createEl("details", { cls: `review-group-settings is-${mode}` });
    if (group.tags.length === 0) section.open = true;
    section.createEl("summary", { text: `${index + 1}. ${group.name} · ${group.tags.length ? group.tags.map((tag) => `#${tag}`).join("、") : "待配置标签"}` });
    const draft = cloneValue(group);
    let tagsText = draft.tags.map((tag) => `#${tag}`).join("\n");
    let learningText = draft.parameters.learningSteps.join(" ");
    let relearningText = draft.parameters.relearningSteps.join(" ");
    const invalid = new Set<string>();
    const error = section.createEl("p", { cls: "review-setting-error", attr: { role: "alert" } });
    new Setting(section).setName("组名称").addText((text) => text.setValue(draft.name).onChange((value) => { draft.name = value; }));
    new Setting(section).setName("标签集").setDesc("每行一个，支持 #中医/伤寒；同组标签匹配任意一个。")
      .addTextArea((text) => {
        text.setValue(tagsText).setPlaceholder("#中医/伤寒\n#科研").onChange((value) => { tagsText = value; });
        text.inputEl.rows = 3;
      });
    const numeric = (name: string, key: keyof Pick<ReviewParameters, "newLimit" | "reviewLimit" | "retention" | "maximumInterval">, min: number, max: number, desc: string) => {
      const isRetention = key === "retention";
      new Setting(section).setName(name).setDesc(desc).addText((text) => {
        text.inputEl.type = "number"; text.inputEl.min = String(min); text.inputEl.max = String(max); text.inputEl.step = "1";
        text.setValue(String(isRetention ? Math.round(draft.parameters[key] * 100) : draft.parameters[key])).onChange((value) => {
          const parsed = Number(value);
          const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= min && parsed <= max;
          text.inputEl.setAttribute("aria-invalid", String(!valid));
          if (valid) { invalid.delete(key); draft.parameters[key] = isRetention ? parsed / 100 : parsed; }
          else invalid.add(key);
          error.setText(valid ? "" : `${name}须为 ${min}–${max} 之间的整数。`);
        });
      });
    };
    numeric("每日新内容", "newLimit", 0, mode === "note" ? 999 : 9999, mode === "note" ? "篇／天，0 表示不引入新笔记" : "张／天，0 表示不引入新卡片");
    numeric("每日到期复习", "reviewLimit", 0, mode === "note" ? 9999 : 99999, "当天首次复习的不同内容数；当天重复练习不重复占额度。");
    numeric("目标记忆率", "retention", 70, 99, "%：数值越高，复习通常越频繁。");
    numeric("最大间隔", "maximumInterval", 1, 36500, "天：只影响以后评分产生的间隔。");
    new Setting(section).setName("学习步长").setDesc("例如 1m 10m；m 为分钟，h 为小时，每步小于一天。留空由 FSRS 安排。")
      .addText((text) => text.setValue(learningText).onChange((value) => { learningText = value; }));
    new Setting(section).setName("重学步长").setDesc("已学内容选择“重来”后的练习间隔；留空由 FSRS 安排。")
      .addText((text) => text.setValue(relearningText).onChange((value) => { relearningText = value; }));
    new Setting(section).setName("保存本组设置").setDesc("新参数从下一次评分生效，已有进度和到期日期保留。")
      .addButton((button) => button.setButtonText("保存").setCta().onClick(async () => {
        try {
          if (invalid.size) throw new Error("请先修正数值输入。");
          if (!draft.name.trim()) throw new Error("请输入组名称。");
          draft.tags = parseTags(tagsText);
          draft.parameters.learningSteps = parseSteps(learningText);
          draft.parameters.relearningSteps = parseSteps(relearningText);
          await this.saveGroups(mode, groupsFor(this.host.settings, mode).map((entry) => entry.id === group.id ? draft : entry));
          new Notice("复习组已保存"); this.display();
        } catch (reason) { error.setText(reason instanceof Error ? reason.message : String(reason)); }
      }));
    new Setting(section).setName("管理复习组").setDesc("复制、排序和删除立即生效；删除组保留全部复习进度。")
      .addButton((button) => button.setButtonText("复制").onClick(async () => {
        const copy = cloneValue(group); copy.id = createId("group"); copy.name += " 副本";
        await this.saveGroups(mode, [...groupsFor(this.host.settings, mode), copy]); this.display();
      }))
      .addButton((button) => button.setButtonText("上移").setDisabled(index === 0).onClick(() => this.moveGroup(mode, index, -1)))
      .addButton((button) => button.setButtonText("下移").setDisabled(index === groupsFor(this.host.settings, mode).length - 1).onClick(() => this.moveGroup(mode, index, 1)))
      .addButton((button) => button.setButtonText("删除组").onClick(async () => {
        await this.saveGroups(mode, groupsFor(this.host.settings, mode).filter((entry) => entry.id !== group.id)); this.display();
      }));
  }

  private async moveGroup(mode: ReviewMode, index: number, direction: number): Promise<void> {
    const groups = [...groupsFor(this.host.settings, mode)];
    const other = index + direction;
    if (other < 0 || other >= groups.length) return;
    [groups[index], groups[other]] = [groups[other], groups[index]];
    await this.saveGroups(mode, groups); this.display();
  }
  private async saveGroups(mode: ReviewMode, groups: ReviewGroup[]): Promise<void> {
    await this.patch(mode === "note" ? { noteGroups: groups } : { cardGroups: groups });
  }
  private async patch(patch: Partial<ReviewCenterSettings>): Promise<void> {
    await this.host.updateSettings({ ...this.host.settings, ...patch });
  }
}
