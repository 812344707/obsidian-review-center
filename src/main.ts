import {
  MarkdownView,
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
} from "./types";
import { createId, pathIsInside } from "./utils";
import { normalizeSettings, validateDataFolder } from "./config";
import { calloutRanges } from "./parser";
import { copyDataDirectory } from "./data-migration";
import { BulkTagsModal } from "./bulk-tags-modal";
import { applyBulkTags, type BulkTagPreview, type BulkTagRequest, type BulkTagResult } from "./tags";
import { REVIEW_CENTER_VIEW, ReviewCenterView } from "./view";

export default class ReviewCenterPlugin extends Plugin {
  settings: ReviewCenterSettings = { ...DEFAULT_SETTINGS };
  store!: ReviewStore;
  service!: ReviewService;
  showDashboard = true;

  private overlay!: ReviewOverlay;
  private overlayMode: OverlayMode | null = null;
  private sourceLeaf: WorkspaceLeaf | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshTimer: number | null = null;
  private legacySettings: ReviewCenterSettings | null = null;
  private migrationPromise: Promise<void> | null = null;
  private tickBusy = false;
  private schemaUpgrade = false;
  private tickSignature = "";

  async onload(): Promise<void> {
    await this.loadSettings();
    const deviceId = this.getOrCreateDeviceId();
    const sessionId = createId("session");
    this.store = new ReviewStore(this.app, () => this.settings, sessionId, deviceId);
    const scanner = new VaultScanner(this.app, this.store, () => this.settings);
    this.service = new ReviewService(
      scanner,
      this.store,
      () => this.settings,
      this.manifest.version,
      (session) => this.saveLocalSession(session),
    );
    this.service.restoreLocalSession(this.loadLocalSession());
    this.overlay = new ReviewOverlay(this);
    this.addChild(this.overlay);

    this.registerView(REVIEW_CENTER_VIEW, (leaf) => new ReviewCenterView(leaf, this));
    this.addRibbonIcon("brain", "打开复习中心", () => void this.openReviewCenter(true));
    this.registerCommands();
    this.addSettingTab(new ReviewCenterSettingTab(this.app, this));
    this.registerVaultEvents();
    this.registerWorkspaceEvents();
    this.registerInterval(window.setInterval(() => void this.tickReview(), 15000));

    this.app.workspace.onLayoutReady(() => {
      void this.initializeAfterLayout();
    });
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.overlay?.detach();
  }

  async updateSettings(next: ReviewCenterSettings): Promise<void> {
    await this.ensureMigrated();
    if (next.dataFolder !== this.settings.dataFolder) throw new Error("请使用“应用并迁移”更换数据目录。");
    const normalized = normalizeSettings(next);
    await this.service.runMaintenance(async () => {
      const removed = this.settings.reviewCalloutTypes.filter((type) => !normalized.reviewCalloutTypes.includes(type));
      if (removed.length) {
        const used: string[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
          if (pathIsInside(file.path, this.settings.dataFolder)) continue;
          if (calloutRanges(await this.app.vault.read(file)).some((range) => removed.includes(range.type))) used.push(file.path);
        }
        if (used.length) throw new Error("这些类型仍被 " + used.length + " 篇笔记使用，暂不能移除：" + used.slice(0, 3).join("、"));
      }
      await this.saveData({ schemaVersion: 3, settings: normalized } satisfies StoredPluginData);
      this.settings = normalized;
    });
    await this.renderOpenViews();
    this.overlay?.sync(this.app.workspace.getMostRecentLeaf());
    this.scheduleRefresh();
  }

  async migrateDataFolder(value: string): Promise<void> {
    const target = validateDataFolder(value);
    if (target === this.settings.dataFolder) return;
    await this.refreshData();
    await this.service.runMaintenance(async () => {
      await this.store.flush();
      await this.store.writeBackup({
        schemaVersion: 3, exportedAt: new Date().toISOString(), pluginVersion: this.manifest.version,
        settings: this.settings, records: this.service.records, history: this.service.history,
      }, "pre-directory-migration");
      const migration = await copyDataDirectory(this.app.vault.adapter, this.settings.dataFolder, target);
      const next = { ...this.settings, dataFolder: migration.target };
      // Save before switching the store's live path. Failure leaves the old path active.
      await this.saveData({ schemaVersion: 3, settings: next } satisfies StoredPluginData);
      this.settings = next;
      try { await migration.complete(); } catch (error) { console.warn("[复习中心] 目录已切换，完成标记待重试", error); }
    });
    await this.refreshData();
    new Notice("复习数据已迁移并核对，旧目录保留为备份");
  }

  async runBulkTags(request: BulkTagRequest, preview: BulkTagPreview[]): Promise<BulkTagResult[]> {
    const result = await this.service.runMaintenance(() => applyBulkTags(this.app, this.settings, request, preview));
    // Metadata updates can arrive after vault.process; the event handler also refreshes.
    await this.refreshData();
    return result;
  }

  async refreshData(showNotice = false): Promise<void> {
    if (this.service?.maintenance) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.ensureMigrated()
      .then(() => this.service.refresh())
      .then(() => {
        if (showNotice) new Notice("复习中心已重新扫描");
      })
      .catch((error: unknown) => {
        console.error("[复习中心] 扫描失败", error);
        new Notice(`复习中心扫描失败：${errorMessage(error)}`);
      })
      .finally(() => {
        this.refreshPromise = null;
        void this.renderOpenViews();
      });
    return this.refreshPromise;
  }

  async openReviewCenter(showDashboard = true): Promise<void> {
    if (this.overlayMode) this.rememberActiveSourceLeaf();
    this.showDashboard = showDashboard;
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
    if (showDashboard && this.service.pendingChanges().length > 0) {
      window.setTimeout(() => {
        new ChangedCardsModal(
          this.app,
          this.service,
          undefined,
          () => void this.renderOpenViews(),
        ).open();
      }, 0);
    }
  }

  async startReview(mode: ReviewMode, extra = false, groupId?: string): Promise<void> {
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return; }
    await this.refreshData();
    const entry = this.service.startSession(mode, extra, groupId);
    if (!entry) {
      new Notice("当前没有可复习内容");
      await this.openReviewCenter(true);
      return;
    }
    this.showDashboard = false;
    if (mode === "note") await this.openActiveNote();
    else await this.openReviewCenter(false);
  }

  async continueReview(): Promise<void> {
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return; }
    await this.refreshData();
    this.service.requeueDue();
    const session = this.service.session;
    if (!session) {
      await this.openReviewCenter(true);
      return;
    }
    this.showDashboard = false;
    if (session.mode === "note") await this.openActiveNote();
    else await this.openReviewCenter(false);
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
    await this.service.undoLast();
    await this.openActiveNote();
  }

  async gradeActiveNote(rating: Grade): Promise<void> {
    if (this.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return; }
    if (this.overlayMode !== "note") return;
    this.overlay.detach();
    await this.service.gradeCurrent(rating);
    const next = this.service.currentEntry();
    if (next) await this.openActiveNote();
    else await this.openReviewCenter(false);
  }

  async returnToReview(): Promise<void> {
    const sourceId = this.getOverlayEntry()?.sourceId;
    this.rememberActiveSourceLeaf();
    this.overlay.detach();
    this.overlayMode = null;
    await this.refreshData();
    await this.openReviewCenter(false);
    const pending = this.service.pendingChanges(sourceId);
    if (pending.length > 0) {
      new ChangedCardsModal(this.app, this.service, sourceId, () => void this.renderOpenViews()).open();
    }
  }

  async exitReview(): Promise<void> {
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
      new Notice("备份已恢复；恢复前数据已另存为 pre-restore 备份");
      await this.openReviewCenter(true);
    } catch (error) {
      console.error("[复习中心] 恢复失败", error);
      new Notice(`恢复失败：${errorMessage(error)}`);
    }
  }

  private async initializeAfterLayout(): Promise<void> {
    await this.refreshData();
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path === this.service.currentEntry()?.sourcePath) {
      this.sourceLeaf = activeView.leaf;
    }
    if (this.settings.autoOpenDashboard) await this.openReviewCenter(true);
  }

  private async openActiveNote(): Promise<void> {
    const entry = this.service.currentEntry();
    if (!entry) {
      await this.openReviewCenter(false);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!(file instanceof TFile)) {
      new Notice("来源笔记不存在，已跳过");
      await this.refreshData();
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
    this.addCommand({ id: "bulk-add-review-tags", name: "批量添加标签", callback: () => new BulkTagsModal(this.app, this).open() });
    this.addCommand({ id: "insert-review-callout", name: "插入复习折叠块", editorCallback: (editor) => {
      editor.replaceSelection("\n> [!review]- 复习\n> 问:: 这里写问题\n> 答:: 这里写答案。\n");
    } });
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
          else void this.service.undoLast().then(() => this.renderOpenViews());
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
      console.warn("[复习中心] 原文标签页已失效，正在重新创建", error);
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
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.onVaultFileChanged(oldPath);
        this.onVaultFileChanged(file.path);
      }),
    );
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onVaultFileChanged(file.path)));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
  }

  private registerWorkspaceEvents(): void {
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
    if (leaf && (leaf.getViewState().type === "markdown" || leaf.view.getViewType() === "markdown")) {
      this.sourceLeaf = leaf;
    }
    this.overlay.sync(leaf);
  }

  private onVaultFileChanged(path: string): void {
    if (!path.toLowerCase().endsWith(".md")) return;
    if (pathIsInside(path, this.settings.dataFolder)) return;
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.service?.maintenance) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshData();
    }, 1200);
  }

  private async renderOpenViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
      if (leaf.view instanceof ReviewCenterView) await leaf.view.render();
    }
  }

  private async loadSettings(): Promise<void> {
    const stored = await this.loadData() as { schemaVersion?: number; settings?: ReviewCenterSettings } | null;
    this.settings = normalizeSettings(stored?.settings);
    this.schemaUpgrade = stored?.schemaVersion !== 3;
    if (stored?.settings && stored.schemaVersion !== 2 && stored.schemaVersion !== 3) this.legacySettings = stored.settings;
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.legacySettings) {
      if (this.schemaUpgrade) {
        await this.saveData({ schemaVersion: 3, settings: this.settings } satisfies StoredPluginData);
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
      await this.saveData({ schemaVersion: 3, settings: this.settings } satisfies StoredPluginData);
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

  private saveLocalSession(session: ReviewSession | null): void {
    const key = `${this.localPrefix()}:session`;
    if (session) window.localStorage.setItem(key, JSON.stringify(session));
    else window.localStorage.removeItem(key);
  }

  private loadLocalSession(): ReviewSession | null {
    const raw = window.localStorage.getItem(`${this.localPrefix()}:session`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReviewSession;
    } catch {
      return null;
    }
  }

  private localPrefix(): string {
    return `review-center:${this.app.vault.getName()}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
