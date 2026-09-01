import {
  ItemView,
  MarkdownRenderer,
  Notice,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";
import { BackupPickerModal, ChangedCardsModal } from "./modals";
import { renderCloze } from "./parser";
import { GRADE_LABELS, REVIEW_GRADES } from "./scheduler";
import type ReviewCenterPlugin from "./main";
import type { QueueEntry, ReviewItem, SourceRecord } from "./types";

export const REVIEW_CENTER_VIEW = "review-center-view";

export class ReviewCenterView extends ItemView {
  private renderVersion = 0;

  constructor(leaf: WorkspaceLeaf, readonly plugin: ReviewCenterPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return REVIEW_CENTER_VIEW;
  }

  getDisplayText(): string {
    return "复习中心";
  }

  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const version = ++this.renderVersion;
    const container = this.contentEl;
    container.empty();
    container.addClass("review-center-view");
    if (!this.plugin.showDashboard && this.plugin.service.currentPendingChange()) {
      this.renderPendingChangeBlock(container);
    } else if (!this.plugin.showDashboard && this.plugin.service.session && !this.plugin.service.currentEntry()) {
      this.renderCompletion(container);
    } else if (!this.plugin.showDashboard && this.plugin.service.session?.mode === "card") {
      await this.renderCardSession(container, version);
    } else {
      this.renderHome(container);
    }
  }

  private renderHome(container: HTMLElement): void {
    const header = container.createDiv({ cls: "review-center-header" });
    const titleGroup = header.createDiv();
    titleGroup.createEl("h1", { text: "复习中心" });
    titleGroup.createEl("p", { text: "先选类型，再按到期顺序开始。" });
    const refresh = header.createEl("button", {
      cls: "review-center-icon-button",
      attr: { "aria-label": "重新扫描" },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => {
      void (async () => {
        refresh.disabled = true;
        await this.plugin.refreshData(true);
        await this.render();
      })();
    });

    if (this.plugin.settings.watchedFolders.length === 0) {
      const onboarding = container.createDiv({ cls: "review-center-callout" });
      onboarding.createEl("strong", { text: "先选择资料文件夹" });
      onboarding.createEl("p", {
        text: "插件不会扫描整个 Vault。请在设置 → 复习中心中填写要纳入复习的文件夹。",
      });
    }

    const pendingCount = this.plugin.service.pendingChanges().length;
    if (pendingCount > 0) {
      const pending = container.createDiv({ cls: "review-center-callout is-warning" });
      pending.createEl("strong", { text: `${pendingCount} 张卡片内容已修改` });
      pending.createEl("p", { text: "需要决定保留原进度还是重置为新卡。" });
      pending
        .createEl("button", { cls: "mod-cta", text: "处理变更" })
        .addEventListener("click", () => {
          new ChangedCardsModal(this.app, this.plugin.service, undefined, () => void this.render()).open();
        });
    }

    const cards = container.createDiv({ cls: "review-center-category-grid" });
    this.renderCategory(cards, "note", "笔记复习", "file-text");
    this.renderCategory(cards, "card", "卡片复习", "layers-3");

    const session = this.plugin.service.session;
    if (session && this.plugin.service.currentEntry()) {
      const continueBox = container.createDiv({ cls: "review-center-continue" });
      continueBox.createSpan({ text: `有一轮${session.mode === "note" ? "笔记" : "卡片"}复习尚未完成。` });
      continueBox
        .createEl("button", { cls: "mod-cta", text: "继续复习" })
        .addEventListener("click", () => void this.plugin.continueReview());
    }

    this.renderWarnings(container);
    this.renderManagement(container);
    this.renderDataActions(container);
  }

  private renderCategory(
    parent: HTMLElement,
    mode: "note" | "card",
    label: string,
    iconName: string,
  ): void {
    const counts = this.plugin.service.counts(mode);
    const card = parent.createDiv({ cls: "review-center-category" });
    const icon = card.createDiv({ cls: "review-center-category-icon" });
    setIcon(icon, iconName);
    card.createEl("h2", { text: label });
    const countRow = card.createDiv({ cls: "review-center-counts" });
    countRow.createSpan({ text: `到期 ${counts.due}` });
    countRow.createSpan({ text: `新内容 ${counts.new}` });
    const start = card.createEl("button", { cls: "mod-cta", text: "开始" });
    start.disabled = counts.due + counts.new === 0;
    start.addEventListener("click", () => void this.plugin.startReview(mode));
    const extra = card.createEl("button", { text: "额外复习" });
    extra.disabled = this.plugin.service.allCount(mode) === 0;
    extra.addEventListener("click", () => void this.plugin.startReview(mode, true));
  }

  private async renderCardSession(container: HTMLElement, version: number): Promise<void> {
    const entry = this.plugin.service.currentEntry();
    if (!entry) {
      this.renderCompletion(container);
      return;
    }
    const progress = this.plugin.service.progress();
    const header = container.createDiv({ cls: "review-session-header" });
    header.createSpan({ text: `${progress.current} / ${progress.total}` });
    header.createEl("strong", { text: entry.sourceTitle });
    const exit = header.createEl("button", { cls: "review-center-icon-button", attr: { "aria-label": "退出" } });
    setIcon(exit, "x");
    exit.addEventListener("click", () => void this.plugin.exitReview());

    const tags = container.createDiv({ cls: "review-card-tags" });
    for (const tag of entry.tags) tags.createSpan({ text: tag });

    const card = container.createDiv({ cls: "review-card" });
    const front = card.createDiv({ cls: "review-card-front markdown-rendered" });
    const frontMarkdown =
      entry.item.kind === "cloze"
        ? renderCloze(entry.item.content.raw, entry.item.clozeIndex ?? 1, false)
        : entry.item.content.question;
    await MarkdownRenderer.render(this.app, frontMarkdown, front, entry.sourcePath, this);
    if (version !== this.renderVersion) return;

    if (!this.plugin.service.session?.answerVisible) {
      card
        .createEl("button", { cls: "mod-cta review-show-answer", text: "显示答案" })
        .addEventListener("click", () => {
          this.plugin.service.setAnswerVisible(true);
          void this.render();
        });
    } else {
      const divider = card.createDiv({ cls: "review-card-divider" });
      divider.setText("答案");
      const answer = card.createDiv({ cls: "review-card-answer markdown-rendered" });
      const answerMarkdown =
        entry.item.kind === "cloze"
          ? renderCloze(entry.item.content.raw, entry.item.clozeIndex ?? 1, true)
          : entry.item.content.answer;
      await MarkdownRenderer.render(this.app, answerMarkdown, answer, entry.sourcePath, this);
      if (version !== this.renderVersion) return;
      this.renderGrades(card, entry);
    }

    const sourceActions = container.createDiv({ cls: "review-source-actions" });
    sourceActions
      .createEl("button", { text: "查看原文" })
      .addEventListener("click", () => void this.plugin.openCardSource(entry, false));
    sourceActions
      .createEl("button", { text: "编辑卡片" })
      .addEventListener("click", () => void this.plugin.openCardSource(entry, true));
    const undo = sourceActions.createEl("button", { text: "撤销上一次" });
    undo.disabled = !this.plugin.service.canUndo();
    undo.addEventListener("click", () => {
      void (async () => {
        await this.plugin.service.undoLast();
        if (this.plugin.service.session?.mode === "note") await this.plugin.continueReview();
        else await this.render();
      })();
    });
  }

  private renderGrades(parent: HTMLElement, entry: QueueEntry): void {
    const preview = this.plugin.service.preview(entry);
    const row = parent.createDiv({ cls: "review-grade-row" });
    for (const grade of REVIEW_GRADES) {
      const button = row.createEl("button", { cls: `review-grade grade-${grade}` });
      button.createSpan({ cls: "review-grade-name", text: GRADE_LABELS[grade] });
      button.createSpan({ cls: "review-grade-interval", text: preview[grade].interval });
      button.addEventListener("click", () => {
        void (async () => {
          for (const sibling of Array.from(row.querySelectorAll("button"))) sibling.disabled = true;
          await this.plugin.service.gradeCurrent(grade);
          await this.render();
        })();
      });
    }
  }

  private renderCompletion(container: HTMLElement): void {
    const done = container.createDiv({ cls: "review-center-complete" });
    const icon = done.createDiv({ cls: "review-center-complete-icon" });
    setIcon(icon, "circle-check-big");
    done.createEl("h1", { text: "本轮完成" });
    const mode = this.plugin.service.session?.mode ?? "card";
    const nextDue = this.plugin.service.nextDue(mode);
    done.createEl("p", {
      text: nextDue
        ? `已完成当前限额内的内容。下次到期：${formatDue(nextDue.toISOString())}`
        : "已完成当前限额内的内容。",
    });
    const undo = done.createEl("button", { text: "撤销上一次" });
    undo.disabled = !this.plugin.service.canUndo();
    undo.addEventListener("click", () => {
      void (async () => {
        await this.plugin.service.undoLast();
        if (this.plugin.service.session?.mode === "note") await this.plugin.continueReview();
        else await this.render();
      })();
    });
    done
      .createEl("button", { cls: "mod-cta", text: "返回复习中心" })
      .addEventListener("click", () => {
        this.plugin.service.finishSession();
        this.plugin.showDashboard = true;
        void this.render();
      });
  }

  private renderPendingChangeBlock(container: HTMLElement): void {
    const box = container.createDiv({ cls: "review-center-complete" });
    const icon = box.createDiv({ cls: "review-center-complete-icon" });
    setIcon(icon, "file-pen-line");
    box.createEl("h1", { text: "卡片内容已修改" });
    box.createEl("p", { text: "先决定保留原进度还是重置，再继续当前卡。" });
    box
      .createEl("button", { cls: "mod-cta", text: "处理变更" })
      .addEventListener("click", () => {
        new ChangedCardsModal(this.app, this.plugin.service, undefined, () => void this.render()).open();
      });
    box
      .createEl("button", { text: "暂时退出" })
      .addEventListener("click", () => void this.plugin.exitReview());
  }

  private renderWarnings(container: HTMLElement): void {
    const warnings = this.plugin.service.records.flatMap((record) =>
      record.warnings.map((warning) => `${record.sourceTitle}：${warning}`),
    );
    if (warnings.length === 0) return;
    const details = container.createEl("details", { cls: "review-center-warnings" });
    details.createEl("summary", { text: `需要处理 ${warnings.length}` });
    const list = details.createEl("ul");
    for (const warning of warnings.slice(0, 100)) list.createEl("li", { text: warning });
  }

  private renderManagement(container: HTMLElement): void {
    const details = container.createEl("details", { cls: "review-center-management" });
    details.createEl("summary", { text: "管理复习内容" });
    const controls = details.createDiv({ cls: "review-management-controls" });
    const search = controls.createEl("input", { type: "search", placeholder: "搜索标题、路径、问题或标签" });
    const filter = controls.createEl("select");
    for (const [value, label] of [
      ["all", "全部"],
      ["active", "正常"],
      ["suspended", "已暂停"],
      ["pending-change", "内容已修改"],
      ["removed", "已移除"],
    ]) {
      filter.createEl("option", { value, text: label });
    }
    const list = details.createDiv({ cls: "review-management-list" });
    const rerender = () => this.renderManagementRows(list, search.value, filter.value);
    search.addEventListener("input", rerender);
    filter.addEventListener("change", rerender);
    rerender();
  }

  private renderManagementRows(parent: HTMLElement, query: string, filter: string): void {
    parent.empty();
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const rows: Array<{ record: SourceRecord; item: ReviewItem }> = [];
    for (const record of this.plugin.service.records) {
      for (const item of [record.note, ...Object.values(record.cards)]) {
        const haystack = [
          record.sourceTitle,
          record.sourcePath,
          item.content.question,
          ...record.tags,
        ]
          .join("\n")
          .toLocaleLowerCase("zh-CN");
        if (normalized && !haystack.includes(normalized)) continue;
        if (filter !== "all" && item.status !== filter) continue;
        rows.push({ record, item });
      }
    }
    if (rows.length === 0) {
      parent.createEl("p", { text: "没有匹配内容。" });
      return;
    }
    for (const { record, item } of rows.slice(0, 200)) {
      const row = parent.createDiv({ cls: "review-management-row" });
      const main = row.createDiv({ cls: "review-management-main" });
      main.createEl("strong", {
        text: item.kind === "note" ? record.sourceTitle : item.content.question.slice(0, 100) || "挖空卡",
      });
      main.createEl("small", {
        text: `${record.sourcePath} · ${statusLabel(item.status)} · 下次 ${formatDue(item.schedule.due)}`,
      });
      const actions = row.createDiv({ cls: "review-management-actions" });
      if (item.status === "suspended") {
        this.managementButton(actions, "恢复", () =>
          this.plugin.service.setItemStatus(record.reviewId, item.id, "resume"),
        );
      } else if (item.status !== "removed") {
        this.managementButton(actions, "暂停", () =>
          this.plugin.service.setItemStatus(record.reviewId, item.id, "suspend"),
        );
      }
      this.managementButton(actions, item.status === "removed" ? "重新加入" : "重置", () =>
        this.plugin.service.setItemStatus(record.reviewId, item.id, "reset"),
      );
      if (item.status !== "removed") {
        this.managementButton(actions, "移除", () =>
          this.plugin.service.setItemStatus(record.reviewId, item.id, "remove"),
        );
      }
    }
    if (rows.length > 200) parent.createEl("p", { text: `仅显示前 200 条，共 ${rows.length} 条。` });
  }

  private managementButton(parent: HTMLElement, text: string, action: () => Promise<void>): void {
    const button = parent.createEl("button", { text });
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true;
        await action();
        await this.render();
      })();
    });
  }

  private renderDataActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "review-center-data-actions" });
    section.createEl("h3", { text: "数据与备份" });
    section.createEl("p", { text: "排程快照与复习历史位于 Vault 的同步数据目录。" });
    const actions = section.createDiv();
    actions.createEl("button", { text: "导出完整 JSON" }).addEventListener("click", () => {
      void (async () => {
        const path = await this.plugin.service.createBackup();
        new Notice(`备份已写入：${path}`);
      })();
    });
    actions.createEl("button", { text: "导出历史 CSV" }).addEventListener("click", () => {
      void (async () => {
        const path = await this.plugin.service.exportHistoryCsv();
        new Notice(`CSV 已写入：${path}`);
      })();
    });
    actions.createEl("button", { text: "恢复 JSON 备份" }).addEventListener("click", () => {
      void (async () => {
        const paths = await this.plugin.store.listBackups();
        new BackupPickerModal(this.app, paths, (path) => void this.plugin.restoreBackup(path)).open();
      })();
    });
  }
}

function statusLabel(status: ReviewItem["status"]): string {
  return {
    active: "正常",
    suspended: "已暂停",
    removed: "已移除",
    "pending-change": "待确认修改",
  }[status];
}

function formatDue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
