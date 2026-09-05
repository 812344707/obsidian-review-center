import {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  type OpenViewState,
  type WorkspaceLeaf,
} from "obsidian";
import { Rating, type Grade } from "ts-fsrs";
import { ChangedCardsModal } from "./modals";
import { ReviewOverlay, type OverlayMode } from "./overlay";
import { VaultScanner } from "./scanner";
import { ReviewService } from "./service";
import { DEFAULT_SETTINGS, ReviewCenterSettingTab } from "./settings";
import { ReviewStore } from "./storage";
import type {
  QueueEntry,
  ReviewCenterSettings,
  ReviewMode,
  ReviewSession,
  StoredPluginData,
  ReviewScope,
  UndoEntry,
} from "./types";
import { createId, pathIsInside, cloneValue } from "./utils";
import { normalizeSettings, validateDataFolder, groupsFor } from "./config";
import { copyDataDirectory } from "./data-migration";
import { BulkTagsModal } from "./bulk-tags-modal";
import { applyBulkTags, type BulkTagPreview, type BulkTagRequest, type BulkTagResult } from "./tags";
import { OptionsWorkspace, ReviewOptionsModal, RenameGroupModal, ConfirmActionModal } from "./options";
import { TagOperationModal } from "./tag-operations";
import { OperationHistoryModal, type OperationJob } from "./operation-history";
import { planReschedule, createRescheduleJob, runRescheduleJob } from "./reschedule";
import { REVIEW_CENTER_VIEW, ReviewCenterView } from "./view";
import type { PreparationProgress } from "./preparation";
import { cardAuthoringEdit, type CardAuthoringAction } from "./card-authoring";
import { parseReviewCallouts } from "./parser";

export default class ReviewCenterPlugin extends Plugin {
  settings: ReviewCenterSettings = { ...DEFAULT_SETTINGS };
  store!: ReviewStore;
  service!: ReviewService;
  showDashboard = true;
  optionsWorkspace!: OptionsWorkspace;
  private originalSettings?: ReviewCenterSettings;

  private overlay!: ReviewOverlay;
  private settingsTab!: ReviewCenterSettingTab;
  private overlayMode: OverlayMode | null = null;
  private sourceLeaf: WorkspaceLeaf | null = null;
  private refreshPromise: Promise<boolean> | null = null;
  preparation: PreparationProgress & { state: "idle" | "running" | "done" | "error" } = { state: "idle", percent: 0, message: "" };
  materialsDirty = false;
  private authorSelection?: { path: string; markdown: string; from: number; to: number };
  private authoringFiles = new Map<string, number>();
  private authoringVersion = 0;
  private authoringTimers = new Map<string, number>();
  private loadPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private legacySettings: ReviewCenterSettings | null = null;
  private migrationPromise: Promise<void> | null = null;
  private tickBusy = false;
  private schemaUpgrade = false;
  private tickSignature = "";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.optionsWorkspace = new OptionsWorkspace(this);
    const deviceId = this.getOrCreateDeviceId();
    const sessionId = createId("session");
    this.store = new ReviewStore(this.app, () => this.settings, sessionId, deviceId);
    const scanner = new VaultScanner(this.app, this.store, () => this.settings);
    this.service = new ReviewService(
      scanner,
      this.store,
      () => this.settings,
      this.manifest.version,
      (session, undo) => this.saveLocalSession(session, undo),
    );
    const saved = this.loadLocalSession();
    this.service.restoreLocalSession(saved.session, saved.undo);
    this.overlay = new ReviewOverlay(this);
    this.addChild(this.overlay);

    this.registerView(REVIEW_CENTER_VIEW, (leaf) => new ReviewCenterView(leaf, this));
    this.addRibbonIcon("brain", "打开渐进式复习", () => void this.openReviewCenter(true));
    this.registerCommands();
    this.settingsTab = new ReviewCenterSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerVaultEvents();
    this.registerWorkspaceEvents();
    this.registerInterval(window.setInterval(() => void this.tickReview(), 15000));

    this.app.workspace.onLayoutReady(() => {
      void this.initializeAfterLayout();
    });
  }

  onunload(): void {
    for (const timer of this.authoringTimers.values()) window.clearTimeout(timer);
    this.service?.setTimingActive(false);
    this.overlay?.detach();
    this.optionsWorkspace?.dispose();
    this.optionsWorkspace?.cancelJob?.();
  }

  openPluginSettings(): void {
    const app = this.app as unknown as { setting: { open(): void; openTabById(id: string): void } };
    app.setting.open(); app.setting.openTabById(this.manifest.id);
  }
  openRecognitionSettings(mode: ReviewMode): void { this.openPluginSettings(); this.settingsTab.showRecognition(mode); }
  async openIssueSource(record: import("./types").SourceRecord, line = 0): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
    if (!(file instanceof TFile)) { new Notice("原文已移动或删除，请先整理数据更新路径。"); return; }
    const leaf = await this.openInSourceLeaf(file, { active: true, eState: { line } });
    if (leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor, position = { line: Math.min(line, editor.lastLine()), ch: 0 };
      editor.setCursor(position); editor.scrollIntoView({ from: position, to: position }, true);
    }
  }
  closePluginSettings(): void { (this.app as unknown as { setting: { close(): void } }).setting.close(); }
  async openManagement(): Promise<void> {
    await this.openReviewCenter(true);
    const view = this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)[0]?.view;
    if (view instanceof ReviewCenterView) view.showPage("manage");
  }
  openOperationHistory(): void { new OperationHistoryModal(this).open(); }
  openReviewOptions(scope: ReviewScope): void { new ReviewOptionsModal(this, scope).open(); }
  renameReviewNode(scope: ReviewScope): void {
    if (scope.tagPath) new TagOperationModal(this, scope, true).open(); else new RenameGroupModal(this, scope).open();
  }
  deleteReviewNode(scope: ReviewScope): void {
    if (scope.tagPath) { new TagOperationModal(this, scope, false).open(); return; }
    const group = groupsFor(this.settings, scope.mode).find((g) => g.id === scope.groupId); if (!group) return;
    new ConfirmActionModal(this, "删除复习组", `删除“${group.name}”的组配置，保留原笔记、卡片进度和历史。`, async () => {
      const next = cloneValue(this.settings), groups = groupsFor(next, scope.mode), index = groups.findIndex((g) => g.id === scope.groupId);
      if (index >= 0) groups.splice(index, 1); await this.updateSettings(next);
    }).open();
  }
  async persistSettingsInMaintenance(next: ReviewCenterSettings): Promise<void> {
    if (!this.service.maintenance) throw new Error("保存批量设置需要先暂停写入。");
    const normalized = normalizeSettings(next);
    await this.saveData({ schemaVersion: 4, settings: normalized } satisfies StoredPluginData);
    this.settings = normalized;
  }
  async saveReviewOptions(next: ReviewCenterSettings): Promise<void> {
    const normalized = normalizeSettings(next), planned = planReschedule(this.service.records, this.service.history, this.settings, normalized);
    if (!planned.entries.length) { await this.updateSettings(normalized); if (planned.skipped.length) new Notice(planned.skipped.join("\n"), 12000); return; }
    await new Promise<void>((resolve, reject) => {
      const preview = planned.entries.slice(0, 8).map((e) => `${e.path}：${new Date(e.before.schedule.due).toLocaleDateString()} → ${new Date(e.after.schedule.due).toLocaleDateString()}`).join("\n");
      new ConfirmActionModal(this, "应用参数并重新排程", `将调整 ${planned.entries.length} 项到期时间，跳过 ${planned.skipped.length} 项。先备份，再暂停评分、扫描和其他批量写入。\n${preview}`, async () => {
        const operation = createRescheduleJob(this, normalized, planned.entries); await runRescheduleJob(this, operation.id, operation.job); resolve();
      }, () => reject(new Error("已取消重新排程，草稿保留。"))).open();
    });
  }

  async updateSettings(next: ReviewCenterSettings): Promise<void> {
    await this.ensureMigrated();
    if (next.dataFolder !== this.settings.dataFolder) throw new Error("请使用“应用并迁移”更换数据目录。");
    const normalized = normalizeSettings(next);
    await this.service.runMaintenance(async () => {
      await this.saveData({ schemaVersion: 4, settings: normalized } satisfies StoredPluginData);
      this.settings = normalized;
    });
    await this.renderOpenViews();
    this.overlay?.sync(this.app.workspace.getMostRecentLeaf());
    this.materialsDirty = true;
    this.updatePreparationState();
  }

  async migrateDataFolder(value: string): Promise<void> {
    const target = validateDataFolder(value);
    if (target === this.settings.dataFolder) return;
    await this.refreshData();
    await this.service.runMaintenance(async () => {
      await this.store.flush();
      await this.store.writeBackup({
        schemaVersion: 4, exportedAt: new Date().toISOString(), pluginVersion: this.manifest.version,
        settings: this.settings, records: this.service.records, history: this.service.history,
      }, "pre-directory-migration");
      const migration = await copyDataDirectory(this.app.vault.adapter, this.settings.dataFolder, target);
      const next = { ...this.settings, dataFolder: migration.target };
      // Save before switching the store's live path. Failure leaves the old path active.
      await this.saveData({ schemaVersion: 4, settings: next } satisfies StoredPluginData);
      this.settings = next;
      try { await migration.complete(); } catch (error) { console.warn("[渐进式复习] 目录已切换，完成标记待重试", error); }
    });
    await this.refreshData();
    new Notice("复习数据已迁移并核对，旧目录保留为备份");
  }

  async runBulkTags(request: BulkTagRequest, preview: BulkTagPreview[]): Promise<BulkTagResult[]> {
    const result = await this.service.runMaintenance(() => applyBulkTags(this.app, this.settings, request, preview));
    // The explicit batch action also prepares its resulting materials.
    await this.refreshData();
    return result;
  }

  async refreshData(showNotice = false): Promise<boolean> {
    if (this.service?.maintenance) return false;
    if (this.refreshPromise) return this.refreshPromise;
    this.preparation = { state: "running", percent: 0, message: "准备整理数据" };
    this.updatePreparationState();
    this.refreshPromise = this.ensureMigrated()
      .then(() => this.service.refresh((progress) => {
        this.preparation = { ...progress, state: "running" };
        this.updatePreparationState();
      }))
      .then(async (ready) => {
        if (!ready) throw new Error("笔记索引尚未就绪，请稍后再次整理数据。");
        await this.store.flush();
        this.materialsDirty = false;
        this.preparation = { state: "done", percent: 100, message: "数据整理完成" };
        if (showNotice) new Notice("数据整理完成，复习进度已保留。");
        return true;
      })
      .catch((error: unknown) => {
        this.materialsDirty = true;
        this.preparation = { ...this.preparation, state: "error", message: `整理未完成：${errorMessage(error)}` };
        console.error("[渐进式复习] 扫描失败", error);
        new Notice(`渐进式复习扫描失败：${errorMessage(error)}`);
        return false;
      })
      .finally(() => {
        this.refreshPromise = null;
        this.updatePreparationState();
        // Starting a review will render its destination. Rebuilding the entire
        // home tree here delays opening the first note/card in large vaults.
        if (!this.startingReview) void this.renderOpenViews();
      });
    return this.refreshPromise;
  }

  async openReviewCenter(showDashboard = true): Promise<void> {
    if (this.overlayMode) this.rememberActiveSourceLeaf();
    this.showDashboard = showDashboard;
    this.service.setTimingActive(!showDashboard && !document.hidden);
    this.overlayMode = null;
    this.overlay.detach();
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(REVIEW_CENTER_VIEW)[0];
    if (!leaf) {
      workspace.iterateAllLeaves((candidate) => {
        if (!leaf && candidate.getViewState().type === REVIEW_CENTER_VIEW) leaf = candidate;
      });
    }
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: REVIEW_CENTER_VIEW, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof ReviewCenterView) await leaf.view.render();
  }

  get startingReview(): boolean { return this.startPromise !== null; }

  captureCardSelection(): void {
    this.authorSelection = undefined;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;
    const markdown = view.editor.getValue();
    let from = view.editor.posToOffset(view.editor.getCursor("from")), to = view.editor.posToOffset(view.editor.getCursor("to"));
    if (view.getMode() === "preview") {
      const selected = view.containerEl.doc.getSelection();
      const text = selected?.toString() ?? "";
      if (text && selected?.anchorNode && view.contentEl.contains(selected.anchorNode)) {
        const at = markdown.indexOf(text);
        if (at < 0 || markdown.indexOf(text, at + 1) >= 0) {
          this.authorSelection = { path: view.file.path, markdown, from: -1, to: -1 }; return;
        }
        from = at; to = at + text.length;
      } else { from = to = Math.min(from, markdown.length); }
    }
    this.authorSelection = { path: view.file.path, markdown, from, to };
  }

  async authorCurrentNote(action: CardAuthoringAction): Promise<void> {
    try {
      if (this.service.maintenance) throw new Error("正在批量处理，请稍后制卡。");
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) throw new Error("请先打开需要制卡的笔记。");
      if (!this.authorSelection) this.captureCardSelection();
      const selection = this.authorSelection; this.authorSelection = undefined;
      if (!selection || selection.path !== view.file.path || selection.markdown !== view.editor.getValue()) throw new Error("笔记或选区已经变化，请重新选择。");
      if (selection.from < 0) throw new Error("阅读模式下无法准确定位这段文字，请切换编辑模式后重新选择。");
      const edit = cardAuthoringEdit(selection.markdown, selection.from, selection.to, action);
      if (view.getMode() !== "source") await view.leaf.setViewState({ ...view.leaf.getViewState(), state: { ...view.leaf.getViewState().state, mode: "source" } });
      if (view.editor.getValue() !== selection.markdown) throw new Error("笔记已经变化，请重试。");
      this.authoringFiles.set(view.file.path, ++this.authoringVersion);
      view.editor.replaceRange(edit.text, view.editor.offsetToPos(edit.from), view.editor.offsetToPos(edit.to));
      view.editor.setCursor(view.editor.offsetToPos(edit.cursor));
      view.editor.focus();
      this.overlay.sync(view.leaf);
    } catch (error) { new Notice(errorMessage(error)); }
  }

  private scheduleAuthoredSource(path: string, markdown: string): void {
    const version = this.authoringFiles.get(path);
    if (version === undefined) return;
    const timer = this.authoringTimers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.authoringTimers.set(path, window.setTimeout(() => {
      this.authoringTimers.delete(path);
      if (this.authoringFiles.get(path) !== version) return;
      const parsed = parseReviewCallouts(markdown);
      if (!parsed.valid || !parsed.cards.length) return;
      void this.service.refreshSource(path).then(() => {
        if (this.authoringFiles.get(path) === version) this.authoringFiles.delete(path);
        this.overlay?.sync(this.app.workspace.getMostRecentLeaf());
      }).catch((error) => {
        // Retain the authored path so the next successful save can retry locally.
        new Notice(errorMessage(error));
      });
    }, 700));
  }

  startReview(mode: ReviewMode, extra = false, groupId?: string, tagPath?: string): Promise<void> {
    return this.runReviewStart(() => this.performStartReview(mode, extra, groupId, tagPath));
  }

  private async performStartReview(mode: ReviewMode, extra: boolean, groupId?: string, tagPath?: string): Promise<void> {
    if (!await this.ensureReviewData()) return;
    this.service.startOrResumeSession(mode, extra, groupId, tagPath);
    const entry = await this.service.prepareCurrent();
    if (!entry && !this.service.currentPendingChange()) {
      new Notice("当前没有可复习内容");
      await this.openReviewCenter(true);
      return;
    }
    this.showDashboard = false;
    if (mode === "note") await this.openActiveNote();
    else await this.openReviewCenter(false);
    this.service.setTimingActive(!document.hidden);
  }

  continueReview(): Promise<void> {
    return this.runReviewStart(() => this.performContinueReview());
  }

  private async performContinueReview(): Promise<void> {
    if (!await this.ensureReviewData()) return;
    this.service.requeueDue();
    const session = this.service.session;
    if (!session) {
      await this.openReviewCenter(true);
      return;
    }
    await this.service.prepareCurrent();
    this.showDashboard = false;
    if (session.mode === "note") await this.openActiveNote();
    else await this.openReviewCenter(false);
    this.service.setTimingActive(!document.hidden);
  }

  private runReviewStart(operation: () => Promise<void>): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return Promise.resolve(); }
    this.startPromise = Promise.resolve().then(operation).catch((error: unknown) => {
      console.error("[渐进式复习] 开始复习失败", error);
      new Notice(`无法开始复习：${errorMessage(error)}`);
    }).finally(() => {
      this.startPromise = null;
      if (this.showDashboard) void this.renderOpenViews();
      else this.updateStartState();
    });
    this.updateStartState();
    return this.startPromise;
  }

  private updateStartState(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
      if (leaf.view instanceof ReviewCenterView) leaf.view.updateStartState();
    }
  }

  private updatePreparationState(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
      if (leaf.view instanceof ReviewCenterView) leaf.view.updatePreparationState();
    }
  }

  private ensureLoaded(): Promise<void> {
    if (this.service.hasLoaded) return Promise.resolve();
    if (!this.loadPromise) this.loadPromise = this.ensureMigrated().then(() => this.service.loadStored())
      .finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }

  private async ensureReviewData(): Promise<boolean> {
    // Starting reads the saved list. Only the explicit preparation action scans the vault.
    if (this.refreshPromise && !await this.refreshPromise) return false;
    await this.ensureLoaded();
    if (!this.service.records.length) {
      new Notice("请先在主页点击“整理数据”，建立复习清单。");
      await this.openReviewCenter(true);
      return false;
    }
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return false; }
    return this.service.hasLoaded;
  }

  async openCardSource(entry: QueueEntry, edit: boolean): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("来源笔记不存在");
      return;
    }
    this.overlayMode = "context";
    this.primeOverlayWhileOpening();
    const leaf = await this.openInSourceLeaf(file, {
      active: true,
      ...(edit ? { state: { mode: "source" } } : {}),
    });
    if (edit && leaf.view instanceof MarkdownView) {
      const line = Math.max(0, entry.item.content.sourceStartLine);
      leaf.view.editor.setCursor({ line, ch: 0 });
      leaf.view.editor.scrollIntoView(
        { from: { line, ch: 0 }, to: { line: Math.max(line, entry.item.content.sourceEndLine), ch: 0 } },
        true,
      );
      leaf.view.editor.focus();
    }
    this.syncOverlayAfterOpen(leaf);
  }

  getOverlayEntry(): QueueEntry | null {
    return this.service.currentEntry();
  }

  getOverlayMode(): OverlayMode | null {
    return this.overlayMode;
  }

  previewCurrent(): ReturnType<ReviewService["preview"]> | null {
    const entry = this.getOverlayEntry();
    return entry ? this.service.preview(entry) : null;
  }

  canUndoReview(): boolean {
    return this.service.canUndo();
  }

  async undoActiveNote(): Promise<void> {
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return; }
    try { await this.service.undoLast(); }
    catch (error) { new Notice(errorMessage(error)); }
    await this.openActiveNote();
  }

  async gradeActiveNote(rating: Grade): Promise<void> {
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return; }
    if (this.overlayMode !== "note") return;
    this.overlay.detach();
    try { await this.service.gradeCurrent(rating); }
    catch (error) { new Notice(errorMessage(error)); }
    const next = this.service.currentEntry();
    if (next) await this.openActiveNote();
    else await this.openReviewCenter(false);
  }

  async returnToReview(): Promise<void> {
    const sourceId = this.getOverlayEntry()?.sourceId;
    this.rememberActiveSourceLeaf();
    this.overlay.detach();
    this.overlayMode = null;
    try { await this.service.prepareCurrent(); }
    catch (error) { new Notice(errorMessage(error)); }
    await this.openReviewCenter(false);
    const pending = this.service.pendingChanges(sourceId);
    if (pending.length > 0) {
      new ChangedCardsModal(this.app, this.service, sourceId, () => void this.renderOpenViews()).open();
    }
  }

  async exitReview(): Promise<void> {
    this.service.setTimingActive(false);
    this.rememberActiveSourceLeaf();
    this.overlay.detach();
    this.overlayMode = null;
    await this.openReviewCenter(true);
  }

  async restoreBackup(path: string): Promise<void> {
    try {
      const restoredSettings = await this.service.restoreBackup(path);
      await this.updateSettings(restoredSettings);
      await this.refreshData();
      new Notice("备份已恢复；恢复前数据已另存为 pre-restore 备份。");
      if (this.service.restoreConflicts.length) {
        const report = new Modal(this.app); report.titleEl.setText("范围恢复报告");
        report.contentEl.createEl("p", { text: `${this.service.restoreConflicts.length} 项与现有内容冲突，已保留本地数据：` });
        for (const item of this.service.restoreConflicts) report.contentEl.createEl("p", { text: item });
        report.open();
      }
      await this.openReviewCenter(true);
    } catch (error) {
      console.error("[渐进式复习] 恢复失败", error);
      new Notice(`恢复失败：${errorMessage(error)}`);
    }
  }

  private async initializeAfterLayout(): Promise<void> {
    try { await this.ensureLoaded(); await this.renderOpenViews(); }
    catch (error) { new Notice(`读取复习清单失败：${errorMessage(error)}`); }
    for (const { id, data } of await this.store.loadJobs<OperationJob>()) {
      if (data.kind === "reschedule" && data.state === "pending") {
        try { await runRescheduleJob(this, id, data); }
        catch (e) { new Notice("未完成的重新排程需要处理：" + String(e), 15000); }
      }
    }
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path === this.service.currentEntry()?.sourcePath) {
      this.sourceLeaf = activeView.leaf;
    }
    if (this.settings.autoOpenDashboard) await this.openReviewCenter(true);
  }

  private async openActiveNote(): Promise<void> {
    let entry: QueueEntry | null;
    try { entry = await this.service.prepareCurrent(); }
    catch (error) { new Notice(errorMessage(error)); await this.openReviewCenter(true); return; }
    if (!entry) {
      await this.openReviewCenter(false);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("来源笔记不存在，已跳过");
      await this.openReviewCenter(false);
      return;
    }
    this.overlayMode = "note";
    this.primeOverlayWhileOpening();
    const leaf = await this.openInSourceLeaf(file, { active: true });
    if (leaf.view instanceof MarkdownView) {
      leaf.view.editor.setCursor({ line: 0, ch: 0 });
      leaf.view.editor.scrollIntoView({ from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } }, true);
    }
    this.syncOverlayAfterOpen(leaf);
  }

  private registerCommands(): void {
    this.addCommand({ id: "organize-materials", name: "整理数据", callback: () => void this.refreshData(true) });
    this.addCommand({ id: "bulk-add-review-tags", name: "批量添加标签", callback: () => new BulkTagsModal(this.app, this).open() });
    this.addCommand({ id: "open-plugin-settings", name: "打开插件设置", callback: () => this.openPluginSettings() });
    for (const [id, name, action] of [["insert-review-callout", "插入复习折叠块", "review"], ["insert-review-qa", "插入问答模板", "qa"], ["insert-review-cloze", "选中文字制作填空", "cloze"]] as const) {
      this.addCommand({ id, name, editorCallback: () => { this.captureCardSelection(); void this.authorCurrentNote(action); } });
    }
    this.addCommand({
      id: "open-dashboard",
      name: "打开面板",
      callback: () => void this.openReviewCenter(true),
    });
    this.addCommand({
      id: "start-note-review",
      name: "开始笔记复习",
      callback: () => void this.startReview("note"),
    });
    this.addCommand({
      id: "start-card-review",
      name: "开始卡片复习",
      callback: () => void this.startReview("card"),
    });
    this.addCommand({
      id: "return-to-review",
      name: "返回当前复习",
      checkCallback: (checking) => {
        const available = this.service.session !== null;
        if (!checking && available) void this.continueReview();
        return available;
      },
    });
    this.addCommand({
      id: "undo-last-review",
      name: "撤销上一次评分",
      checkCallback: (checking) => {
        const available = this.service.canUndo();
        if (!checking && available) {
          if (this.service.session?.mode === "note") void this.undoActiveNote();
          else void this.service.undoLast().catch((error) => new Notice(errorMessage(error))).then(() => this.renderOpenViews());
        }
        return available;
      },
    });
    const labels: Array<[Grade, string]> = [
      [Rating.Again, "重来"],
      [Rating.Hard, "困难"],
      [Rating.Good, "良好"],
      [Rating.Easy, "简单"],
    ];
    for (const [grade, label] of labels) {
      this.addCommand({
        id: `rate-note-${grade}`,
        name: `当前笔记评分：${label}`,
        checkCallback: (checking) => {
          const available = this.overlayMode === "note" && this.getOverlayEntry() !== null;
          if (!checking && available) void this.gradeActiveNote(grade);
          return available;
        },
      });
    }
  }

  private getSourceLeaf(file: TFile): WorkspaceLeaf {
    if (this.sourceLeaf && this.sourceLeaf.getViewState().type !== REVIEW_CENTER_VIEW) {
      return this.sourceLeaf;
    }
    this.sourceLeaf = null;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file?.path === file.path) {
      this.sourceLeaf = activeView.leaf;
      return activeView.leaf;
    }

    const loadedLeaf = this.findLoadedMarkdownLeaf(file.path);
    if (loadedLeaf) {
      this.sourceLeaf = loadedLeaf;
      return loadedLeaf;
    }

    let match: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (match) return;
      const state = leaf.getViewState();
      const stateFile = typeof state.state?.file === "string" ? state.state.file : null;
      if (
        (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) ||
        (state.type === "markdown" && stateFile === file.path)
      ) {
        match = leaf;
      }
    });
    this.sourceLeaf = match ?? this.app.workspace.getLeaf("tab");
    return this.sourceLeaf;
  }

  private async openInSourceLeaf(file: TFile, openState: OpenViewState): Promise<WorkspaceLeaf> {
    let leaf = this.getSourceLeaf(file);
    try {
      await leaf.openFile(file, openState);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      await this.app.workspace.revealLeaf(leaf);
      return await this.resolveOpenedSourceLeaf(file, leaf);
    } catch (error) {
      console.warn("[渐进式复习] 原文标签页已失效，正在重新创建", error);
      this.sourceLeaf = null;
      leaf = this.app.workspace.getLeaf("tab");
      this.sourceLeaf = leaf;
      await leaf.openFile(file, openState);
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      await this.app.workspace.revealLeaf(leaf);
      return await this.resolveOpenedSourceLeaf(file, leaf);
    }
  }

  private async resolveOpenedSourceLeaf(file: TFile, fallback: WorkspaceLeaf): Promise<WorkspaceLeaf> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const activeLeaf = this.app.workspace.getMostRecentLeaf();
      if (activeLeaf && this.isMarkdownLeafForPath(activeLeaf, file.path)) {
        this.sourceLeaf = activeLeaf;
        return activeLeaf;
      }
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView?.file?.path === file.path) {
        this.sourceLeaf = activeView.leaf;
        return activeView.leaf;
      }
      const loadedLeaf = this.findLoadedMarkdownLeaf(file.path);
      if (loadedLeaf) {
        this.sourceLeaf = loadedLeaf;
        return loadedLeaf;
      }
      if (this.isMarkdownLeafForPath(fallback, file.path)) {
        this.sourceLeaf = fallback;
        return fallback;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    this.sourceLeaf = fallback;
    return fallback;
  }

  private rememberActiveSourceLeaf(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.sourceLeaf = activeView.leaf;
      return;
    }
    const sourcePath = this.service.currentEntry()?.sourcePath;
    if (sourcePath) this.sourceLeaf = this.findLoadedMarkdownLeaf(sourcePath);
  }

  private findLoadedMarkdownLeaf(path: string): WorkspaceLeaf | null {
    let match: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!match && this.isMarkdownLeafForPath(leaf, path)) match = leaf;
    });
    return match;
  }

  private isMarkdownLeafForPath(leaf: WorkspaceLeaf, path: string): boolean {
    const state = leaf.getViewState();
    if (state.type !== "markdown" && leaf.view.getViewType() !== "markdown") return false;
    const stateFile = typeof state.state?.file === "string" ? state.state.file : null;
    const viewFile = leaf.view instanceof MarkdownView ? leaf.view.file?.path : null;
    return (viewFile ?? stateFile) === path;
  }

  private syncOverlayAfterOpen(leaf: WorkspaceLeaf): void {
    this.overlay.sync(leaf, true);
    for (const delay of [50, 200, 600]) {
      window.setTimeout(() => {
        const activeLeaf = this.app.workspace.getMostRecentLeaf();
        const sourcePath = this.service.currentEntry()?.sourcePath ?? "";
        if (activeLeaf && this.isMarkdownLeafForPath(activeLeaf, sourcePath)) {
          this.sourceLeaf = activeLeaf;
          this.overlay.sync(activeLeaf, true);
        } else if (this.sourceLeaf === leaf) {
          this.overlay.sync(leaf, true);
        }
      }, delay);
    }
  }

  private primeOverlayWhileOpening(): void {
    const sync = () => {
      const leaf = this.app.workspace.getMostRecentLeaf() ?? this.sourceLeaf;
      if (leaf) this.overlay.sync(leaf, true);
    };
    sync();
    for (const delay of [100, 300, 700, 1500]) window.setTimeout(sync, delay);
  }

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!file.path.toLowerCase().endsWith(".md") || pathIsInside(file.path, this.settings.dataFolder)) return;
      this.service.sourceCreated(file.path);
      // Startup re-announces existing files; it should not ask for preparation on every launch.
      if (this.service.hasLoaded && !this.service.records.some((record) => record.sourcePath === file.path)) {
        this.materialsDirty = true;
        this.updatePreparationState();
      }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (pathIsInside(oldPath, this.settings.dataFolder) && pathIsInside(file.path, this.settings.dataFolder)) return;
        for (const path of [...this.authoringFiles.keys()]) if (pathIsInside(path, oldPath)) {
          const timer = this.authoringTimers.get(path);
          if (timer !== undefined) window.clearTimeout(timer);
          this.authoringTimers.delete(path);
          this.authoringFiles.delete(path);
          this.authoringFiles.set(file.path + path.slice(oldPath.length), ++this.authoringVersion);
        }
        this.service.sourceRenamed(oldPath, file.path);
        this.materialsDirty = true;
        this.updatePreparationState();
      }),
    );
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (file, markdown) => {
      this.service.metadataReady(file.path, markdown);
      this.scheduleAuthoredSource(file.path, markdown);
    }));
  }

  private registerWorkspaceEvents(): void {
    this.registerDomEvent(document, "visibilitychange", () => this.syncActiveLeaf(this.app.workspace.getMostRecentLeaf()));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => this.syncActiveLeaf(leaf)),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        for (const delay of [0, 50, 200]) {
          window.setTimeout(() => this.syncActiveLeaf(this.app.workspace.getMostRecentLeaf()), delay);
        }
      }),
    );
  }

  private syncActiveLeaf(leaf: WorkspaceLeaf | null): void {
    const entry = this.service.currentEntry();
    const reviewing = !this.showDashboard && (leaf?.view.getViewType() === REVIEW_CENTER_VIEW || (leaf?.view as MarkdownView | undefined)?.file?.path === entry?.sourcePath);
    this.service.setTimingActive(!document.hidden && reviewing);
    if (leaf && (leaf.getViewState().type === "markdown" || leaf.view.getViewType() === "markdown")) {
      this.sourceLeaf = leaf;
    }
    this.overlay.sync(leaf);
  }

  private onVaultFileChanged(path: string): void {
    if (!path.toLowerCase().endsWith(".md")) return;
    if (pathIsInside(path, this.settings.dataFolder)) return;
    this.service.sourceChanged(path);
    this.materialsDirty = true;
    this.updatePreparationState();
  }

  private async renderOpenViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
      if (leaf.view instanceof ReviewCenterView) await leaf.view.render();
    }
  }

  private async loadSettings(): Promise<void> {
    const stored = await this.loadData() as { schemaVersion?: number; settings?: ReviewCenterSettings } | null;
    this.originalSettings = stored?.settings;
    this.settings = normalizeSettings(stored?.settings);
    this.schemaUpgrade = stored?.schemaVersion !== 4;
    if (stored?.settings && ![2, 3, 4].includes(stored.schemaVersion ?? 0)) this.legacySettings = stored.settings;
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.legacySettings) {
      if (this.schemaUpgrade) {
        await this.store.initialize();
        if (this.originalSettings) await this.store.writeBackup({ schemaVersion: 3, exportedAt: new Date().toISOString(), pluginVersion: "0.3.0", settings: this.originalSettings, records: await this.store.loadAllRecords(), history: await this.store.loadAllHistory() }, "pre-options-migration");
        await this.saveData({ schemaVersion: 4, settings: this.settings } satisfies StoredPluginData);
        this.schemaUpgrade = false;
      }
      return;
    }
    if (this.migrationPromise) return this.migrationPromise;
    this.migrationPromise = (async () => {
      await this.store.initialize();
      await this.store.writeBackup({
        schemaVersion: 1, exportedAt: new Date().toISOString(), pluginVersion: "0.1.0",
        settings: this.legacySettings!, records: await this.store.loadAllRecords(), history: await this.store.loadAllHistory(),
      }, "pre-tags-migration");
      await this.saveData({ schemaVersion: 4, settings: this.settings } satisfies StoredPluginData);
      this.legacySettings = null;
      this.schemaUpgrade = false;
      this.service.finishSession();
      new Notice("旧版复习数据已备份。请配置笔记和卡片标签集，原有进度会继续保留。");
    })().finally(() => { this.migrationPromise = null; });
    return this.migrationPromise;
  }

  private async tickReview(): Promise<void> {
    if (this.tickBusy || this.refreshPromise || !this.service || this.service.maintenance) return;
    this.tickBusy = true;
    try {
      const waiting = this.service.session && !this.service.currentEntry();
      const changed = this.service.requeueDue();
      if (waiting && changed && !this.showDashboard && this.service.session?.mode === "note") await this.openActiveNote();
      const views = this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW);
      const signature = JSON.stringify([new Date().toDateString(), this.service.counts("note"), this.service.counts("card")]);
      const dashboardChanged = signature !== this.tickSignature;
      this.tickSignature = signature;
      if ((this.showDashboard && dashboardChanged) || (waiting && changed)) {
        for (const leaf of views) if (leaf.view instanceof ReviewCenterView) await leaf.view.render();
      }
    } finally { this.tickBusy = false; }
  }

  private getOrCreateDeviceId(): string {
    const key = `${this.localPrefix()}:device-id`;
    let value = window.localStorage.getItem(key);
    if (!value) {
      value = createId("device");
      window.localStorage.setItem(key, value);
    }
    return value;
  }

  private saveLocalSession(session: ReviewSession | null, undo: UndoEntry[]): void {
    const key = `${this.localPrefix()}:session`;
    if (session) {
      try { window.localStorage.setItem(key, JSON.stringify({ ...session, undoStack: undo.slice(-1) })); }
      catch { window.localStorage.setItem(key, JSON.stringify(session)); }
    }
    else window.localStorage.removeItem(key);
  }

  private loadLocalSession(): { session: ReviewSession | null; undo: UndoEntry[] } {
    const raw = window.localStorage.getItem(`${this.localPrefix()}:session`);
    const empty = { session: null, undo: [] };
    if (!raw) return empty;
    try {
      const { undoStack, ...session } = JSON.parse(raw);
      if (!session.id || !["note", "card"].includes(session.mode) || !Array.isArray(session.entryKeys) ||
        !session.entryKeys.every((key: unknown) => typeof key === "string") || !Number.isInteger(session.currentIndex) || session.currentIndex < 0) return empty;
      const undo = Array.isArray(undoStack) ? undoStack.filter((entry) => entry?.eventId && entry?.sourceId && entry?.itemId &&
        entry.before?.id === entry.itemId && entry.after?.id === entry.itemId && entry.before?.schedule && entry.after?.schedule) : [];
      return { session: session as ReviewSession, undo };
    } catch {
      return empty;
    }
  }

  private localPrefix(): string {
    return `review-center:${this.app.vault.getName()}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
