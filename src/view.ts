import {
  ItemView,
  Menu,
  MarkdownRenderer,
  Notice,
  setIcon,
  type WorkspaceLeaf,
} from "obsidian";
import { BackupPickerModal, ChangedCardsModal } from "./modals";
import { renderCloze } from "./parser";
import { GRADE_LABELS, REVIEW_GRADES } from "./scheduler";
import type ReviewCenterPlugin from "./main";
import { groupsFor, resolveGroup } from "./config";
import { buildReviewTree, flattenTree, type ReviewTreeNode } from "./tree";
import { defaultStatisticsState, renderStatistics } from "./statistics-view";
import type { QueueEntry, ReviewItem, ReviewMode, SourceRecord } from "./types";

export const REVIEW_CENTER_VIEW = "review-center-view";

export class ReviewCenterView extends ItemView {
  private renderVersion = 0;
  private homeMode: ReviewMode = "note";
  private selected: Partial<Record<ReviewMode, string>> = {};
  private expanded: Record<string, boolean> = {};
  private homeScroll = 0;
  private statsScroll = 0;
  private statistics = defaultStatisticsState();
  private page: "home" | "stats" | "manage" = "home";
  private get homeKey(): string { return `review-center:${this.app.vault.getName()}:home`; }
  showPage(page: "home" | "stats" | "manage"): void {
    if (page === "stats" && this.page !== "stats") {
      this.statistics.mode = this.homeMode;
      this.statistics.scopes[this.homeMode] = this.selected[this.homeMode] ?? "";
      this.statsScroll = 0;
    }
    this.page = page; void this.render();
  }
  private saveHome(): void {
    window.localStorage.setItem(this.homeKey, JSON.stringify({ mode: this.homeMode, selected: this.selected, expanded: this.expanded, scroll: this.homeScroll, statistics: this.statistics }));
  }

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
    try {
      const state = JSON.parse(window.localStorage.getItem(this.homeKey) ?? "{}");
      this.homeMode = state.mode === "card" ? "card" : "note";
      this.selected = state.selected ?? {}; this.expanded = state.expanded ?? {}; this.homeScroll = state.scroll ?? 0;
      const stats = state.statistics;
      if (stats) this.statistics = { mode: stats.mode === "card" ? "card" : "note", scopes: stats.scopes && typeof stats.scopes === "object" ? stats.scopes : {}, forecastDays: stats.forecastDays === 30 ? 30 : 7, activityDays: stats.activityDays === 7 ? 7 : 30, activityMetric: stats.activityMetric === "time" ? "time" : "items" };
    } catch { /* A damaged presentation preference never affects review data. */ }
    await this.render();
  }

  async render(): Promise<void> {
    const version = ++this.renderVersion;
    const container = this.contentEl;
    const scroll = container.querySelector<HTMLElement>(".review-tree-scroll");
    if (scroll) { this.homeScroll = scroll.scrollTop; this.saveHome(); }
    if (container.hasClass("is-statistics")) this.statsScroll = container.scrollTop;
    const focused = container.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.statsFocus : undefined;
    container.empty();
    container.removeClass("is-tree-home");
    container.removeClass("is-statistics");
    container.addClass("review-center-view");
    if (this.plugin.service.restoringSession) {
      container.createEl("p", { text: "正在读取复习进度…", attr: { role: "status" } });
      return;
    }
    if (!this.plugin.showDashboard && this.plugin.service.currentPendingChange()) {
      this.renderPendingChangeBlock(container);
    } else if (!this.plugin.showDashboard && this.plugin.service.session && !this.plugin.service.currentEntry()) {
      this.renderCompletion(container);
    } else if (!this.plugin.showDashboard && this.plugin.service.session?.mode === "card") {
      await this.renderCardSession(container, version);
    } else {
      this.renderHome(container);
    }
    if (container.hasClass("is-statistics")) {
      container.scrollTop = this.statsScroll;
      if (focused) container.querySelector<HTMLElement>(`[data-stats-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }
  }

  private renderHome(container: HTMLElement): void {
    if (this.page !== "home") {
      const bar = container.createDiv({ cls: "review-home-toolbar" });
      bar.createEl("button", { text: "← 返回复习组" }).onclick = () => this.showPage("home");
      bar.createEl("strong", { text: this.page === "stats" ? "复习统计" : "内容与备份" });
      if (this.page === "stats") {
        container.addClass("is-statistics");
        renderStatistics(container, this.plugin.service.records, this.plugin.service.history, this.plugin.settings, this.statistics, (resetScroll) => {
          if (resetScroll) container.scrollTop = 0;
          this.saveHome(); void this.render();
        });
      } else { this.renderWarnings(container); this.renderManagement(container); this.renderDataActions(container); }
      return;
    }
    container.addClass("is-tree-home");
    const bar = container.createDiv({ cls: "review-home-toolbar" });
    const tabs = bar.createDiv({ cls: "review-home-tabs", attr: { role: "tablist", "aria-label": "复习类型" } });
    for (const [mode, label] of [["note", "笔记"], ["card", "卡片"]] as const) {
      const button = tabs.createEl("button", { text: label, cls: mode === this.homeMode ? "is-active" : "", attr: { role: "tab", "aria-selected": String(mode === this.homeMode) } });
      button.onclick = () => { this.homeMode = mode; this.homeScroll = 0; const old = container.querySelector(".review-tree-scroll"); if (old) old.scrollTop = 0; this.saveHome(); void this.render(); };
    }
    const nodes = buildReviewTree(this.plugin.service.records, this.plugin.settings, this.homeMode), flat = flattenTree(nodes);
    const selected = flat.find((n) => n.id === this.selected[this.homeMode]) ?? nodes[0];
    if (selected) this.selected[this.homeMode] = selected.id;
    const actions = bar.createDiv({ cls: "review-home-actions" });
    actions.createEl("button", { text: "统计", attr: { "aria-label": "查看复习统计" } }).onclick = () => this.showPage("stats");
    const start = actions.createEl("button", { cls: "mod-cta", text: "开始" });
    const count = selected ? this.plugin.service.counts(this.homeMode, selected.groupId, selected.tagPath) : null;
    start.disabled = !count || count.due + count.new === 0 || this.plugin.service.maintenance;
    start.onclick = () => { if (selected) void this.plugin.startReview(this.homeMode, false, selected.groupId, selected.tagPath); };
    const refresh = actions.createEl("button", { cls: "review-center-icon-button", attr: { "aria-label": "刷新复习内容" } });
    setIcon(refresh, "refresh-cw"); refresh.onclick = () => { refresh.disabled = true; void this.plugin.refreshData(true); };
    actions.createEl("button", { text: "设置", attr: { "aria-label": "打开插件设置" } }).onclick = () => this.plugin.openPluginSettings();
    const issues = this.plugin.service.pendingChanges().length;
    const warnings = this.plugin.service.records.reduce((n, r) => n + r.warnings.length, 0);
    if (issues || warnings) {
      const notice = container.createDiv({ cls: "review-home-notice" });
      notice.createSpan({ text: issues ? `${issues} 张卡片内容有变化` : `${warnings} 项需要处理` });
      notice.createEl("button", { text: "查看" }).onclick = () => issues ? new ChangedCardsModal(this.app, this.plugin.service, undefined, () => void this.render()).open() : this.showPage("manage");
    }
    const scroll = container.createDiv({ cls: "review-tree-scroll" });
    const table = scroll.createDiv({ cls: "review-tree", attr: { role: "treegrid", "aria-label": "复习组和标签" } });
    const head = table.createDiv({ cls: "review-tree-row review-tree-heading", attr: { role: "row" } });
    for (const label of ["复习组", "未学习", "学习中", "待复习", ""]) head.createDiv({ text: label, attr: { role: "columnheader" } });
    const add = (node: ReviewTreeNode, depth: number) => {
      const counts = this.plugin.service.counts(node.mode, node.groupId, node.tagPath);
      const open = this.expanded[node.id] ?? !node.tagPath;
      const row = table.createDiv({ cls: `review-tree-row${node.id === selected?.id ? " is-selected" : ""}`, attr: { role: "row", "aria-level": String(depth + 1), "aria-selected": String(node.id === selected?.id), tabindex: "0", ...(node.children.length ? { "aria-expanded": String(open) } : {}) } });
      const label = row.createDiv({ cls: "review-tree-name", attr: { role: "gridcell" } });
      label.style.setProperty("--tree-depth", String(Math.min(depth, 5)));
      const toggle = label.createEl("button", { cls: "review-tree-toggle", attr: { "aria-label": `${open ? "收起" : "展开"}${node.label}`, tabindex: "-1" } });
      if (node.children.length) { setIcon(toggle, open ? "chevron-down" : "chevron-right"); toggle.onclick = (event) => { event.stopPropagation(); this.expanded[node.id] = !open; this.saveHome(); void this.render(); }; }
      else { toggle.disabled = true; toggle.setAttribute("aria-hidden", "true"); }
      label.createSpan({ text: node.label, attr: { title: node.tagPath ? "#" + node.tagPath : node.label } });
      for (const [value, cls] of [[counts.new, "new"], [counts.learning, "learning"], [counts.review, "review"]] as const) row.createDiv({ cls: `review-tree-count is-${cls}${value === 0 ? " is-zero" : ""}`, text: String(value), attr: { role: "gridcell" } });
      const cell = row.createDiv({ attr: { role: "gridcell" } });
      const gear = cell.createEl("button", { cls: "review-tree-gear", attr: { "aria-label": `${node.label}菜单` } });
      setIcon(gear, "settings"); gear.onclick = (event) => { event.stopPropagation(); this.nodeMenu(node, event); };
      const select = () => { this.selected[this.homeMode] = node.id; this.saveHome(); void this.render(); };
      row.onclick = select;
      row.onkeydown = (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
        if (["ArrowRight", "ArrowLeft"].includes(event.key) && node.children.length) { event.preventDefault(); this.expanded[node.id] = event.key === "ArrowRight"; void this.render(); }
        if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const rows = Array.from(table.querySelectorAll<HTMLElement>('[role="row"][tabindex]')); rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]?.focus(); }
      };
      if (open) node.children.forEach((child) => add(child, depth + 1));
    };
    nodes.forEach((node) => add(node, 0));
    if (!nodes.length || !groupsFor(this.plugin.settings, this.homeMode).some((g) => g.tags.length)) {
      const empty = table.createDiv({ cls: "review-tree-empty" });
      empty.createEl("p", { text: "先为复习组选择标签，内容会自动出现在这里。" });
      empty.createEl("button", { text: "设置复习组" }).onclick = () => this.plugin.openPluginSettings();
    }
    const foot = container.createDiv({ cls: "review-tree-footer" });
    foot.createSpan({ text: "数量为当前可开始的内容", attr: { title: "数量已扣除每日上限和搁置内容。多标签内容会重复显示，父级与实际复习按内容去重，父级不一定等于子级相加。" } });
    const help = foot.createEl("button", { text: "?", attr: { "aria-label": "数量说明" } });
    help.onclick = () => new Notice("多标签内容可在多个分支显示；父级数量和实际队列会去重。尚未到时间、已暂停、待确认或已搁置的内容不计入。", 10000);
    scroll.scrollTop = this.homeScroll;
    scroll.onscroll = () => { this.homeScroll = scroll.scrollTop; this.saveHome(); };
  }

  private nodeMenu(node: ReviewTreeNode, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("重命名").setIcon("pencil").onClick(() => this.plugin.renameReviewNode(node)));
    menu.addItem((i) => i.setTitle("选项").setIcon("settings").onClick(() => this.plugin.openReviewOptions(node)));
    menu.addItem((i) => i.setTitle("导出").setIcon("download").onClick(() => { void this.plugin.service.exportScope(node).then((path) => new Notice("范围备份已写入：" + path)).catch((e) => new Notice(String(e))); }));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("删除").setIcon("trash-2").onClick(() => this.plugin.deleteReviewNode(node)));
    menu.showAtMouseEvent(event);
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

    const card = container.createDiv({ cls: `review-card is-${entry.item.kind}` });
    card.createEl("div", { cls: "review-card-kind", text: `${entry.item.kind === "qa" ? "问答卡" : "挖空卡"} · ${entry.group.name}` });
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
        if (this.plugin.service.maintenance) { new Notice("正在迁移或批量处理，请稍候。"); return; }
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
    const nextDue = this.plugin.service.nextDue(mode, this.plugin.service.session?.groupId, this.plugin.service.session?.tagPath);
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
    details.open = true;
    const controls = details.createDiv({ cls: "review-management-controls" });
    const search = controls.createEl("input", { type: "search", placeholder: "搜索标题、路径、问题或标签" });
    const filter = controls.createEl("select");
    for (const [value, label] of [
      ["all", "全部"],
      ["active", "正常"],
      ["suspended", "已暂停"],
      ["pending-change", "内容已修改"],
      ["removed", "已移除"],
      ["leech", "记忆难点"],
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
        if (filter === "leech" ? !item.leech : filter !== "all" && item.status !== filter) continue;
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
      const group = resolveGroup(record.tags, groupsFor(this.plugin.settings, item.kind === "note" ? "note" : "card"));
      const scope = record.sourceStatus !== "out-of-scope" && group ? group.name : "范围外，进度保留";
      main.createEl("strong", {
        text: item.kind === "note" ? record.sourceTitle : item.content.question.slice(0, 100) || "挖空卡",
      });
      main.createEl("small", {
        text: `${record.sourcePath} · ${scope} · ${statusLabel(item.status)} · 下次 ${formatDue(item.schedule.due)}`,
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
