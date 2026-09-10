import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { groupsFor, parseTags } from "./config";
import type { ReviewCenterSettings, ReviewMode } from "./types";
import { folderInput, tagInput, TagInput } from "./inputs";
import { BulkTagsModal } from "./bulk-tags-modal";
import type ReviewCenterPlugin from "./main";
import { groupTag, replaceGroupTag, setReviewTags, tagGroups } from "./tag-groups";
import { groupFilter } from "./recognition";
import { renderExercisePageName, validateExercisePageFolder } from "./exercise-page";
export { DEFAULT_SETTINGS } from "./config";

const TABS = [["groups", "复习标签"], ["exercise", "习题页"], ["data", "数据与备份"], ["display", "显示"]] as const;
type SettingsPage = typeof TABS[number][0];
type DisplayDraft = Pick<ReviewCenterSettings, "showNoteHeatmap" | "showCardHeatmap" | "autoOpenDashboard">;
type ExercisePageDraft = Pick<ReviewCenterSettings, "exercisePageFolder" | "exercisePageNameTemplate">;

export class ReviewCenterSettingTab extends PluginSettingTab {
  private page: SettingsPage = "groups";
  private cleaners: Array<() => void> = [];
  private folderDraft?: string;
  private exercisePageDraft?: ExercisePageDraft;
  private displayDraft?: DisplayDraft;
  private migrating = false;
  private repairMessage = "";
  constructor(app: App, private readonly host: ReviewCenterPlugin) { super(app, host); }
  showRecognition(mode: ReviewMode): void {
    this.page = "groups"; this.update();
    this.containerEl.querySelector<HTMLInputElement>(`[data-review-tags="${mode}"] input`)?.focus();
  }
  hide(): void { this.clean(); }
  private clean(): void {
    this.cleaners.forEach((clean) => clean()); this.cleaners = [];
    this.host.optionsWorkspace.dispose();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "复习标签、习题页、数据与备份、显示",
      aliases: ["笔记", "知识点", "标签", "习题", "文件名模板", "时间变量", "数据目录", "迁移", "备份", "修复知识库", "重建索引", "热力图", "启动", "review"],
      render: (setting) => {
        // Keep the compact tabs and explicit Save while using native search.
        setting.settingEl.empty(); setting.settingEl.removeClass("setting-item");
        this.draw(setting.settingEl);
        return () => this.clean();
      },
    }];
  }

  private draw(root: HTMLElement): void {
    this.clean();
    root.empty(); root.addClass("review-center-settings");
    const tabs = root.createDiv({ cls: "review-settings-tabs", attr: { role: "tablist", "aria-label": "渐进式复习设置分类" } });
    TABS.forEach(([id, label], index) => {
      const button = tabs.createEl("button", { text: label, cls: this.page === id ? "is-active" : "", attr: {
        type: "button", role: "tab", id: "review-settings-tab-" + id, "aria-selected": String(this.page === id),
        "aria-controls": "review-settings-panel", tabindex: this.page === id ? "0" : "-1",
      } });
      const select = (next: SettingsPage) => {
        this.page = next; this.update();
        const active = this.containerEl.querySelector<HTMLElement>("#review-settings-tab-" + next);
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
    else if (this.page === "exercise") this.renderExercisePage(panel);
    else if (this.page === "data") this.renderData(panel);
    else this.renderDisplay(panel);
  }

  private renderExercisePage(root: HTMLElement): void {
    this.exercisePageDraft ??= this.currentExercisePage();
    const draft = this.exercisePageDraft;
    const preview = root.createDiv({ cls: "review-settings-intro", attr: { role: "status", "aria-live": "polite" } });
    const updatePreview = () => {
      try {
        const folder = validateExercisePageFolder(draft.exercisePageFolder, this.host.settings.dataFolder);
        const filename = renderExercisePageName(draft.exercisePageNameTemplate, "原文标题");
        preview.setText(`预览：${folder}/${filename}`);
      } catch (error) { preview.setText(error instanceof Error ? error.message : String(error)); }
    };
    new Setting(root).setName("习题保存文件夹").setDesc("知识库内的非隐藏子目录；不存在时创建。")
      .addText((t) => {
        t.setPlaceholder("习题").setValue(draft.exercisePageFolder).onChange((value) => {
          draft.exercisePageFolder = value; updatePreview();
        });
        const suggest = folderInput(this.app, t.inputEl, (value) => {
          draft.exercisePageFolder = value; t.setValue(value); updatePreview();
        });
        this.cleaners.push(() => suggest.close());
      });
    new Setting(root).setName("文件名模板").setDesc("支持 {{title}}、{{date}} 和 {{time}}；自动添加 .md。")
      .addText((t) => t.setPlaceholder("{{title}}-习题-{{date}}-{{time}}")
        .setValue(draft.exercisePageNameTemplate).onChange((value) => {
          draft.exercisePageNameTemplate = value; updatePreview();
        }));
    updatePreview();
    this.saveRow(root, "保存习题页设置", "只影响以后新建的习题页。", async () => {
      const exercisePageFolder = validateExercisePageFolder(draft.exercisePageFolder, this.host.settings.dataFolder);
      renderExercisePageName(draft.exercisePageNameTemplate, "原文标题");
      await this.patch({ exercisePageFolder, exercisePageNameTemplate: draft.exercisePageNameTemplate.trim() });
      this.exercisePageDraft = this.currentExercisePage();
    }, () => { this.exercisePageDraft = this.currentExercisePage(); });
  }

  private renderGroups(root: HTMLElement): void {
    root.createEl("p", { cls: "review-settings-intro", text: "一个标签就是一组，子标签自动展开。例如添加 #医学，#医学/伤寒 也会进入复习。可直接选择已有标签或输入新标签。" });
    const workspace = this.host.optionsWorkspace;
    for (const mode of ["note", "card"] as const) {
      const title = mode === "note" ? "笔记复习标签" : "知识点复习标签";
      const row = new Setting(root).setName(title).setDesc(mode === "note" ? "带这些标签的整篇笔记，按天安排阅读和整理。" : "识别带这些标签的笔记中的问答和挖空，使用独立的复习参数。");
      row.settingEl.dataset.reviewTags = mode;
      const key = "review-tags:" + mode;
      const selected = () => tagGroups(groupsFor(workspace.draft, mode)).map((group) => groupTag(group)!);
      const input = new TagInput(this.app, row.controlEl, selected(), (tags) => {
        setReviewTags(workspace.draft, mode, tags); workspace.raw.set(key, input.input.value);
      }, title);
      input.input.value = workspace.raw.get(key) ?? "";
      input.input.addEventListener("input", () => { workspace.raw.set(key, input.input.value); });
      workspace.validators.set(key, () => {
        const pending = workspace.raw.get(key);
        if (pending?.trim()) setReviewTags(workspace.draft, mode, [...selected(), ...parseTags(pending)]);
        workspace.raw.delete(key);
      });
      this.cleaners.push(() => input.destroy());
    }
    root.createEl("p", { cls: "review-settings-intro", text: "在笔记属性或正文中添加标签，然后点击主页“整理数据”。复习数量和间隔可在对应标签的齿轮 → 选项中调整。" });
    this.renderLegacyGroups(root);
    this.saveRow(root, "保存复习标签", "移除这里的标签只停止纳入；原文标签、复习进度和历史保留。",
      () => workspace.save(), () => workspace.reset());
    new Setting(root).setName("批量纳入文章").setDesc("按文件夹或标签集筛选文章，预览后补充复习标签。")
      .addButton((b) => b.setButtonText("批量添加标签").onClick(() => new BulkTagsModal(this.app, this.host).open()));
  }

  private renderLegacyGroups(root: HTMLElement): void {
    const workspace = this.host.optionsWorkspace;
    const legacy = (["note", "card"] as const).flatMap((mode) => {
      const groups = groupsFor(workspace.draft, mode), editable = new Set(tagGroups(groups));
      return groups.filter((group) => !editable.has(group)).map((group) => ({ mode, group }));
    });
    if (!legacy.length) return;
    const box = root.createEl("details", { cls: "review-legacy-groups" });
    box.createEl("summary", { text: `原有分组（${legacy.length}）` });
    box.createEl("p", { cls: "review-settings-intro", text: "原来的组合条件继续生效。选择一个标签可替换该组的范围，保留参数和进度；保存后生效。" });
    for (const { mode, group } of legacy) {
      const filter = groupFilter(group), labels = { is: "是", "is-not": "不是", contains: "包含", excludes: "排除" };
      const description = filter.rules.map((r) => `${r.field === "tag" ? "标签 #" : "文件夹 "}${r.value}（${labels[r.operator]}）`).join(filter.match === "all" ? "，且 " : "，或 ") || "尚未设置范围";
      const row = new Setting(box).setName(`${mode === "note" ? "笔记" : "知识点"} · ${group.name}`).setDesc(description);
      let value = "";
      row.addText((t) => {
        t.setPlaceholder("选择替代标签").onChange((v) => { value = v; });
        const suggest = tagInput(this.app, t.inputEl, (v) => { value = v; }); this.cleaners.push(() => suggest.close());
      });
      const error = box.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
      row.addButton((b) => b.setButtonText("改用标签").onClick(() => {
        try { replaceGroupTag(workspace.draft, mode, group.id, value); this.update(); }
        catch (e) { error.setText(e instanceof Error ? e.message : String(e)); }
      }));
      row.addButton((b) => b.setButtonText("移除").onClick(() => {
        const groups = groupsFor(workspace.draft, mode); groups.splice(groups.indexOf(group), 1); this.update();
      }));
    }
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
    this.renderRepair(root);
  }

  private renderRepair(root: HTMLElement): void {
    new Setting(root).setName("修复知识库")
      .setDesc("用于无法开始复习、笔记路径变化或复习清单异常。先自动备份，再重新核对本插件的标签、路径和卡片索引；保留评分与排程，无法确认的内容会提示核对。")
      .addButton((button) => {
        button.buttonEl.dataset.repairVault = "";
        button.setButtonText("修复知识库").onClick(() => {
          this.repairMessage = "";
          void this.host.repairVault().then((result) => {
            this.repairMessage = `已核对 ${result.records} 篇笔记。${result.issues ? `${result.issues} 篇需要在内容管理中核对。` : "复习进度已保留。"}修复前备份：${result.backupPath}`;
          }).catch((error: unknown) => {
            this.repairMessage = `修复未完成：${error instanceof Error ? error.message : String(error)}`;
          }).finally(() => { this.updateRepairState(); });
        });
      });
    root.createDiv({ cls: "review-settings-intro", text: this.repairMessage,
      attr: { "data-repair-status": "", role: "status", "aria-live": "polite" } });
    this.updateRepairState();
  }

  updateRepairState(): void {
    const button = this.containerEl.querySelector<HTMLButtonElement>("[data-repair-vault]");
    if (button) {
      button.disabled = this.host.repairingVault || this.host.startingReview || this.host.preparation.state === "running" || this.host.service.maintenance || this.migrating;
      button.textContent = this.host.repairingVault ? "正在修复…" : "修复知识库";
      button.setAttribute("aria-busy", String(this.host.repairingVault));
    }
    const status = this.containerEl.querySelector<HTMLElement>("[data-repair-status]");
    if (status) status.textContent = this.host.repairingVault
      ? `${this.host.preparation.message}（${this.host.preparation.percent}%）` : this.repairMessage;
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
  private currentExercisePage(): ExercisePageDraft {
    const { exercisePageFolder, exercisePageNameTemplate } = this.host.settings;
    return { exercisePageFolder, exercisePageNameTemplate };
  }
  private saveRow(root: HTMLElement, title: string, description: string, save: () => Promise<void>, reset: () => void): void {
    const error = root.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    const row = new Setting(root).setName(title).setDesc(description);
    row.addButton((b) => b.setButtonText("还原草稿").onClick(() => { reset(); this.update(); }));
    row.addButton((b) => b.setButtonText("保存").setCta().onClick(() => {
      b.setDisabled(true);
      void Promise.resolve().then(save).then(() => {
        this.update();
        this.containerEl.createDiv({ cls: "review-settings-saved", text: title + "已完成", attr: { role: "status" } });
      })
        .catch((e) => { error.setText(e instanceof Error ? e.message : String(e)); })
        // Obsidian components are thenable; returning one makes Promise assimilation loop.
        .finally(() => { b.setDisabled(false); });
    }));
  }
  private openManagement(): void { this.host.closePluginSettings(); void this.host.openManagement(); }
  private async patch(patch: Partial<ReviewCenterSettings>): Promise<void> { await this.host.updateSettings({ ...this.host.settings, ...patch }); }
}
