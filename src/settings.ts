import { App, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from "obsidian";
import { groupsFor, parseTags } from "./config";
import type { AutoQuestionSettings, ReviewCenterSettings, ReviewMode } from "./types";
import { folderInput, tagInput, TagInput } from "./inputs";
import { BulkTagsModal } from "./bulk-tags-modal";
import type ReviewCenterPlugin from "./main";
import { groupTag, replaceGroupTag, setReviewTags, tagGroups } from "./tag-groups";
import { groupFilter } from "./recognition";
import { renderExercisePageName, validateExercisePageFolder } from "./exercise-page";
import {
  AUTO_QUESTION_PROVIDER_PRESETS,
  assertSafeApiTransport,
  renderAutoQuestionPrompt,
  validateAutoQuestionEndpoint,
  validateAutoQuestionFolder,
} from "./auto-question";
export { DEFAULT_SETTINGS } from "./config";

const TABS = [["groups", "复习标签"], ["exercise", "习题页"], ["auto-question", "自动出题"], ["data", "数据与备份"], ["display", "显示"]] as const;
type SettingsPage = typeof TABS[number][0];
type DisplayDraft = Pick<ReviewCenterSettings, "showNoteHeatmap" | "showCardHeatmap" | "autoOpenDashboard">;
type ExercisePageDraft = Pick<ReviewCenterSettings, "exercisePageFolder" | "exercisePageNameTemplate" | "exercisePageTags">;
type AutoQuestionDraft = Omit<AutoQuestionSettings, "batchSize" | "masteryThreshold" | "maxQuestions" | "maxSourceCharacters"> & {
  batchSize: string;
  masteryPercent: string;
  maxQuestions: string;
  maxSourceCharacters: string;
};

export class ReviewCenterSettingTab extends PluginSettingTab {
  private page: SettingsPage = "groups";
  private cleaners: Array<() => void> = [];
  private folderDraft?: string;
  private inactiveFolderDraft = "";
  private exercisePageDraft?: ExercisePageDraft;
  private autoQuestionDraft?: AutoQuestionDraft;
  private displayDraft?: DisplayDraft;
  private migrating = false;
  private repairMessage = "";
  constructor(app: App, private readonly host: ReviewCenterPlugin) { super(app, host); }
  showRecognition(mode: ReviewMode): void {
    this.page = "groups"; this.update();
    this.containerEl.querySelector<HTMLInputElement>(`[data-review-tags="${mode}"] input`)?.focus();
  }
  syncDataFolder(path: string): void { this.folderDraft = path; }
  hide(): void { this.clean(); }
  private clean(): void {
    this.cleaners.forEach((clean) => clean()); this.cleaners = [];
    this.host.optionsWorkspace.dispose();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: "复习标签、习题页、自动出题、数据与备份、显示",
      aliases: ["笔记", "知识点", "标签", "习题", "自动出题", "大模型", "API", "提示词", "题库", "掌握率", "文件名模板", "时间变量", "数据目录", "迁移", "备份", "修复知识库", "重建索引", "热力图", "启动", "review"],
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
    else if (this.page === "auto-question") this.renderAutoQuestion(panel);
    else if (this.page === "data") this.renderData(panel);
    else this.renderDisplay(panel);
  }

  private renderAutoQuestion(root: HTMLElement): void {
    this.autoQuestionDraft ??= this.currentAutoQuestion();
    const draft = this.autoQuestionDraft;
    root.createEl("p", { cls: "review-settings-intro", text: "从当前笔记取材，把问答卡写入指定题库。题库还有未作答卡片时等待；全部作答后，掌握率未达标才继续出题，达标或到上限即停止。" });
    new Setting(root).setName("复习后自动评估").setDesc("默认关闭。开启后，只在最后一张未作答的自动题目完成评分时评估；仅在需要继续时发起一次 API 请求。")
      .addToggle((toggle) => toggle.setValue(draft.enabled).onChange((value) => { draft.enabled = value; }));
    new Setting(root).setName("API 提供商").setDesc("选择常见服务可自动填写协议和地址；模型 ID 与密钥仍由你填写。选择自定义后可接其他服务。")
      .addDropdown((dropdown) => {
        for (const [id, preset] of Object.entries(AUTO_QUESTION_PROVIDER_PRESETS)) dropdown.addOption(id, preset.label);
        dropdown.setValue(draft.provider).onChange((value) => {
          const provider = value in AUTO_QUESTION_PROVIDER_PRESETS ? value as keyof typeof AUTO_QUESTION_PROVIDER_PRESETS : "custom";
          const preset = AUTO_QUESTION_PROVIDER_PRESETS[provider];
          draft.provider = provider;
          if (provider !== "custom") {
            draft.apiFormat = preset.apiFormat;
            draft.endpoint = preset.endpoint;
          }
          this.update();
        });
      });
    new Setting(root).setName("API 协议").setDesc("支持 OpenAI 新版接口、OpenAI 兼容聊天补全、Anthropic 消息接口与 Gemini 内容生成接口。")
      .addDropdown((dropdown) => dropdown
        .addOption("responses", "OpenAI 新版接口")
        .addOption("chat-completions", "OpenAI 兼容聊天补全")
        .addOption("anthropic-messages", "Anthropic 消息接口")
        .addOption("gemini-generate-content", "Google Gemini 内容生成")
        .setValue(draft.apiFormat)
        .onChange((value) => {
          draft.apiFormat = value === "chat-completions" || value === "anthropic-messages" || value === "gemini-generate-content"
            ? value : "responses";
          draft.provider = "custom";
          this.update();
        }));
    new Setting(root).setName("API 地址").setDesc("请填完整请求地址。原文与题库表现会发送给该服务；其数据政策由对应提供商决定。")
      .addText((text) => text.setPlaceholder("API 请求地址").setValue(draft.endpoint)
        .onChange((value) => { draft.endpoint = value; }));
    new Setting(root).setName("模型名称").setDesc("必须与提供商控制台显示的模型 ID 完全一致；预设不会锁定某个易过时的模型版本。")
      .addText((text) => text.setPlaceholder(AUTO_QUESTION_PROVIDER_PRESETS[draft.provider].modelHint).setValue(draft.model).onChange((value) => { draft.model = value; }));
    new Setting(root).setName("API 密钥").setDesc("从 Obsidian SecretStorage 选择或新建。设置文件只保存密钥名称，不保存密钥值；无密钥的本地接口可留空。")
      .addComponent((element) => new SecretComponent(this.app, element).setValue(draft.apiKeySecret)
        .onChange((value) => { draft.apiKeySecret = value; }));
    new Setting(root).setName("题库文件夹").setDesc("同一来源的自动题目追加到一篇 Markdown 题库；不覆盖人工修改。")
      .addText((text) => {
        text.setPlaceholder("自动题库").setValue(draft.outputFolder).onChange((value) => { draft.outputFolder = value; });
        const suggest = folderInput(this.app, text.inputEl, (value) => { draft.outputFolder = value; text.setValue(value); });
        this.cleaners.push(() => suggest.close());
      });
    const tagsRow = new Setting(root).setName("题库标签").setDesc("加到新题库，应至少命中一个“知识点复习标签”或其他识别条件。");
    const tagsInput = new TagInput(this.app, tagsRow.controlEl, draft.tags, (tags) => { draft.tags = tags; }, "自动题库标签");
    this.cleaners.push(() => tagsInput.destroy());
    for (const [key, name, desc, placeholder] of [
      ["batchSize", "每批出题数", "1–20 题。", "5"],
      ["masteryPercent", "停止掌握率", "全部作答后，最新评分为“良好/简单”的卡片占比达到该百分比时停止。", "90"],
      ["maxQuestions", "单个来源题目上限", "达到上限后不再请求 API。", "50"],
      ["maxSourceCharacters", "原文字符上限", "超过时中止，不静默截断原文。", "30000"],
    ] as const) {
      new Setting(root).setName(name).setDesc(desc).addText((text) => {
        text.inputEl.type = "number"; text.inputEl.inputMode = "numeric";
        text.setPlaceholder(placeholder).setValue(draft[key]).onChange((value) => { draft[key] = value; });
      });
    }
    new Setting(root).setName("自定义提示词").setDesc("支持 {{source_title}}、{{source_path}}、{{source_content}}、{{question_count}}、{{mastery_percent}}、{{weak_questions}}、{{existing_questions}}。输出 JSON 结构由插件另行约束。")
      .addTextArea((area) => {
        area.setValue(draft.prompt).onChange((value) => { draft.prompt = value; });
        area.inputEl.rows = 16; area.inputEl.addClass("review-auto-question-prompt");
      });
    new Setting(root).setName("当前笔记").setDesc("手动执行一次“评估→等待/停止/继续出题”。即使自动评估关闭，此按钮仍可用。")
      .addButton((button) => button.setButtonText("评估并继续").onClick(() => void this.host.runAutoQuestionGeneration()));
    this.saveRow(root, "保存自动出题设置", "保存只写入非敏感配置；API 密钥值由 Obsidian SecretStorage 单独管理。", async () => {
      const batchSize = integerField(draft.batchSize, 1, 20, "每批出题数");
      const masteryPercent = integerField(draft.masteryPercent, 50, 100, "停止掌握率");
      const maxQuestions = integerField(draft.maxQuestions, 1, 500, "题目上限");
      const maxSourceCharacters = integerField(draft.maxSourceCharacters, 1_000, 200_000, "原文字符上限");
      if (maxQuestions < batchSize) throw new Error("单个来源题目上限不能小于每批出题数。");
      if (draft.enabled && !draft.model.trim()) throw new Error("开启自动评估前，请填写模型名称。");
      const endpoint = validateAutoQuestionEndpoint(draft.endpoint);
      assertSafeApiTransport(endpoint);
      const outputFolder = validateAutoQuestionFolder(draft.outputFolder, this.host.settings.dataFolder);
      renderAutoQuestionPrompt(draft.prompt, {
        sourceTitle: "原文标题", sourcePath: "资料/原文.md", sourceContent: "原文内容",
        questionCount: batchSize, masteryRate: 0.5, weakQuestions: [], existingQuestions: [],
      });
      await this.patch({ autoQuestion: {
        enabled: draft.enabled,
        provider: draft.provider,
        apiFormat: draft.apiFormat,
        endpoint,
        model: draft.model.trim(),
        apiKeySecret: draft.apiKeySecret.trim(),
        prompt: draft.prompt,
        outputFolder,
        tags: tagsInput.values(),
        batchSize,
        masteryThreshold: masteryPercent / 100,
        maxQuestions,
        maxSourceCharacters,
      } });
      this.autoQuestionDraft = this.currentAutoQuestion();
    }, () => { this.autoQuestionDraft = this.currentAutoQuestion(); });
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
    new Setting(root).setName("文件名模板").setDesc("支持 {{title}}、{{date}}、{{time}} 和 {{yyyy-HHmm-ss}} 等时间格式；自动添加 .md。")
      .addText((t) => t.setPlaceholder("{{title}}-习题-{{date}}-{{time}}")
        .setValue(draft.exercisePageNameTemplate).onChange((value) => {
          draft.exercisePageNameTemplate = value; updatePreview();
        }));
    const tagsRow = new Setting(root).setName("习题页标签").setDesc("添加到以后新建的习题页，并与来源笔记标签合并。留空时只复制来源标签。");
    const tagsInput = new TagInput(this.app, tagsRow.controlEl, draft.exercisePageTags, (tags) => {
      draft.exercisePageTags = tags;
    }, "习题页标签");
    this.cleaners.push(() => tagsInput.destroy());
    updatePreview();
    this.saveRow(root, "保存习题页设置", "只影响以后新建的习题页。", async () => {
      const exercisePageFolder = validateExercisePageFolder(draft.exercisePageFolder, this.host.settings.dataFolder);
      renderExercisePageName(draft.exercisePageNameTemplate, "原文标题");
      const exercisePageTags = tagsInput.values();
      await this.patch({ exercisePageFolder, exercisePageNameTemplate: draft.exercisePageNameTemplate.trim(), exercisePageTags });
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
    new Setting(root).setName("复习数据目录").setDesc("知识库内的相对路径。应用后先复制、逐文件核对并重新读取新目录，再把未发生同步变化的旧目录移入系统废纸篓；系统废纸篓不可用时移入知识库 .trash。")
      .addText((t) => {
        t.setValue(this.folderDraft!).onChange((v) => { this.folderDraft = v; });
        const suggest = folderInput(this.app, t.inputEl, (v) => { this.folderDraft = v; });
        this.cleaners.push(() => suggest.close());
      }).addButton((b) => b.setButtonText("应用并迁移").setDisabled(this.migrating).onClick(() => void (async () => {
        if (this.migrating) return;
        this.migrating = true; b.setDisabled(true); message.setText("正在核对和迁移，请稍候…");
        try {
          await this.host.migrateDataFolder(this.folderDraft!); this.folderDraft = this.host.settings.dataFolder;
          message.setText("当前目录：" + this.folderDraft + "。旧目录已安全移入废纸篓；若迁移期间发生同步变化，插件会保留并提示。");
        } catch (error) { message.setText(String(error)); }
        finally { this.migrating = false; b.setDisabled(false); }
      })()));
    new Setting(root).setName("清理迁移遗留目录").setDesc("仅用于旧版迁移后仍残留的非活动目录。必须明确填写旧路径并再次确认；当前数据目录永远不会被清理。")
      .addText((t) => {
        t.setPlaceholder("例如 复习中心数据").setValue(this.inactiveFolderDraft).onChange((v) => { this.inactiveFolderDraft = v; });
        const suggest = folderInput(this.app, t.inputEl, (v) => { this.inactiveFolderDraft = v; t.setValue(v); });
        this.cleaners.push(() => suggest.close());
      })
      .addButton((b) => b.setDestructive().setButtonText("移入废纸篓").onClick(() => void (async () => {
        message.setText("");
        try { await this.host.trashInactiveDataFolder(this.inactiveFolderDraft); this.inactiveFolderDraft = ""; this.update(); }
        catch (error) { message.setText(error instanceof Error ? error.message : String(error)); }
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
    const { exercisePageFolder, exercisePageNameTemplate, exercisePageTags } = this.host.settings;
    return { exercisePageFolder, exercisePageNameTemplate, exercisePageTags: [...exercisePageTags] };
  }
  private currentAutoQuestion(): AutoQuestionDraft {
    const value = this.host.settings.autoQuestion;
    return {
      ...value,
      tags: [...value.tags],
      batchSize: String(value.batchSize),
      masteryPercent: String(Math.round(value.masteryThreshold * 100)),
      maxQuestions: String(value.maxQuestions),
      maxSourceCharacters: String(value.maxSourceCharacters),
    };
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

function integerField(value: string, minimum: number, maximum: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}须为 ${minimum}–${maximum} 之间的整数。`);
  }
  return parsed;
}
