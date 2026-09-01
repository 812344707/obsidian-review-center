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
import { createId, isWatchedPath } from "./utils";
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

    this.app.workspace.onLayoutReady(() => {
      void this.initializeAfterLayout();
    });
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.overlay?.detach();
  }

  async updateSettings(next: ReviewCenterSettings): Promise<void> {
    this.settings = sanitizeSettings(next);
    const stored: StoredPluginData = { schemaVersion: 1, settings: this.settings };
    await this.saveData(stored);
    this.scheduleRefresh();
  }

  async refreshData(showNotice = false): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.service
      .refresh()
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

  async startReview(mode: ReviewMode, extra = false): Promise<void> {
    const entry = this.service.startSession(mode, extra);
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
    await this.service.undoLast();
    await this.openActiveNote();
  }

  async gradeActiveNote(rating: Grade): Promise<void> {
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
    if (
      !isWatchedPath(
        path,
        this.settings.watchedFolders,
        this.settings.excludedFolders,
        this.settings.dataFolder,
      ) &&
      !this.service.records.some((record) => record.sourcePath === path)
    ) {
      return;
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
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
    const stored = (await this.loadData()) as Partial<StoredPluginData> | null;
    this.settings = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      ...(stored?.settings ?? {}),
    });
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

function sanitizeSettings(settings: ReviewCenterSettings): ReviewCenterSettings {
  return {
    ...settings,
    watchedFolders: uniqueFolders(settings.watchedFolders),
    excludedFolders: uniqueFolders(settings.excludedFolders),
    reviewHeading: settings.reviewHeading.trim() || DEFAULT_SETTINGS.reviewHeading,
    reviewHeadingLevel: clampInteger(settings.reviewHeadingLevel, 1, 6),
    dataFolder: settings.dataFolder.replace(/^\/+|\/+$/g, "").trim() || DEFAULT_SETTINGS.dataFolder,
    noteNewLimit: clampInteger(settings.noteNewLimit, 0, 999),
    noteReviewLimit: clampInteger(settings.noteReviewLimit, 0, 9999),
    cardNewLimit: clampInteger(settings.cardNewLimit, 0, 9999),
    cardReviewLimit: clampInteger(settings.cardReviewLimit, 0, 99999),
    noteRetention: clampNumber(settings.noteRetention, 0.7, 0.99),
    cardRetention: clampNumber(settings.cardRetention, 0.7, 0.99),
  };
}

function uniqueFolders(folders: string[]): string[] {
  return [...new Set((folders ?? []).map((folder) => folder.replace(/^\/+|\/+$/g, "").trim()).filter(Boolean))];
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clampNumber(Number(value), minimum, maximum));
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
