import { heatmapDays } from "./activity";
import { buildReviewTree, flattenTree } from "./tree";
import { activityDuration, buildStatistics, type ActivityDay } from "./statistics";
import type { HistoryEvent, ReviewCenterSettings, ReviewMode, SourceRecord } from "./types";

export interface StatisticsViewState {
  mode: ReviewMode;
  scopes: Partial<Record<ReviewMode, string>>;
  forecastDays: 7 | 30;
  activityDays: 7 | 30;
  activityMetric: "items" | "time";
}
export function defaultStatisticsState(): StatisticsViewState {
  return { mode: "note", scopes: {}, forecastDays: 7, activityDays: 30, activityMetric: "items" };
}

function note(parent: HTMLElement, text: string): HTMLElement {
  return parent.createEl("p", { cls: "review-stats-note", text });
}
function section(parent: HTMLElement, title: string, subtitle?: string): HTMLElement {
  const el = parent.createEl("section", { cls: "review-stats-section" });
  el.createEl("h3", { text: title });
  if (subtitle) note(el, subtitle);
  return el;
}
function metric(parent: HTMLElement, label: string, value: string, kind?: string): void {
  const el = parent.createDiv({ cls: `review-stats-metric${kind ? ` is-${kind}` : ""}` });
  el.createSpan({ cls: "review-stats-label", text: label });
  el.createEl("strong", { text: value });
}
function choices<T extends string | number>(parent: HTMLElement, label: string, values: Array<[T, string]>, selected: T, change: (value: T) => void): void {
  const el = parent.createDiv({ cls: "review-stats-choices", attr: { role: "group", "aria-label": label } });
  for (const [value, text] of values) {
    const button = el.createEl("button", { text, cls: value === selected ? "is-active" : "", attr: { type: "button", "aria-pressed": String(value === selected), "data-stats-focus": `${label}-${value}` } });
    button.onclick = () => change(value);
  }
}
function help(parent: HTMLElement, title: string, text: string): void {
  const details = parent.createEl("details", { cls: "review-stats-help" });
  details.createEl("summary", { text: title }); note(details, text);
}

interface Bar { date: string; segments: Array<{ value: number; kind: string }>; label: string; detail: string }
function chart(parent: HTMLElement, bars: Bar[], title: string, unit: string, latest = false): void {
  const highest = Math.max(0, ...bars.map((b) => b.segments.reduce((n, s) => n + s.value, 0)));
  const max = Math.max(1, highest);
  const hint = note(parent, `${title} · ${bars[0].date.slice(5)} — ${bars[bars.length - 1].date.slice(5)} · 最高 ${Number(highest.toFixed(1))} ${unit}`);
  hint.addClass("review-stats-chart-caption");
  const viewport = parent.createDiv({ cls: "review-stats-chart-scroll", attr: { tabindex: "0", "aria-label": `${title}，可左右滚动` } });
  const plot = viewport.createDiv({ cls: "review-stats-chart", attr: { role: "group", "aria-label": title } });
  plot.style.setProperty("--stats-columns", String(bars.length));
  const detail = note(parent, "点击柱形查看当天明细"); detail.setAttribute("aria-live", "polite"); detail.addClass("review-stats-chart-detail");
  for (const bar of bars) {
    const button = plot.createEl("button", { cls: "review-stats-bar", attr: { type: "button", "aria-label": bar.detail, title: bar.detail } });
    button.createSpan({ cls: "review-stats-bar-value", text: bar.label });
    const track = button.createSpan({ cls: "review-stats-bar-track" });
    for (const segment of bar.segments) {
      const fill = track.createSpan({ cls: `review-stats-bar-fill is-${segment.kind}` });
      fill.style.height = `${segment.value / max * 100}%`;
    }
    button.createSpan({ cls: "review-stats-bar-date", text: bar.date.slice(5).replace("-", "/") });
    const show = () => detail.setText(bar.detail);
    button.onclick = show; button.onfocus = show;
  }
  if (latest) window.requestAnimationFrame(() => { if (viewport.isConnected) viewport.scrollLeft = viewport.scrollWidth; });
}

function dayDetails(day: ActivityDay, unit: string): string {
  return `${day.date} · 新学 ${day.fresh} ${unit} · 复习 ${day.reviewed} ${unit}${day.unclassified ? ` · 未分类 ${day.unclassified} ${unit}` : ""} · ${day.attempts} 次评分 · 用时 ${activityDuration(day)}${day.timed < day.attempts ? `（${day.attempts - day.timed} 次未记录）` : ""}`;
}

export function renderStatistics(parent: HTMLElement, records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings, state: StatisticsViewState, changed: (resetScroll?: boolean) => void): void {
  const controls = parent.createDiv({ cls: "review-stats-controls" });
  choices(controls, "统计类型", [["note", "笔记"], ["card", "卡片"]], state.mode, (value) => { state.mode = value; changed(true); });
  const picker = controls.createEl("label", { cls: "review-stats-scope" });
  picker.createSpan({ text: "统计范围" });
  const select = picker.createEl("select", { attr: { "aria-label": "统计范围", "data-stats-focus": "scope" } });
  select.createEl("option", { value: "", text: "全部复习组" });
  const nodes = flattenTree(buildReviewTree(records, settings, state.mode));
  const groups = new Map(nodes.filter((n) => !n.tagPath).map((n) => [n.groupId, n.label]));
  for (const node of nodes) select.createEl("option", { value: node.id, text: node.tagPath ? `${groups.get(node.groupId)} › #${node.tagPath}` : node.label });
  const node = nodes.find((n) => n.id === state.scopes[state.mode]);
  select.value = node?.id ?? "";
  select.onchange = () => { state.scopes[state.mode] = select.value; changed(true); };
  const scope = node ?? { mode: state.mode };
  const now = new Date(), data = buildStatistics(records, history, settings, scope, now);
  const unit = state.mode === "note" ? "篇" : "张";
  const scopeLabel = node ? (node.tagPath ? `${groups.get(node.groupId)} › #${node.tagPath}` : node.label) : "全部复习组";
  note(parent, `${scopeLabel} · ${state.mode === "note" ? "笔记" : "卡片"}统计 · ${now.toLocaleDateString()} 更新`);

  const today = section(parent, "今日概览");
  const metrics = today.createDiv({ cls: "review-stats-metrics" });
  metric(metrics, "今日新学", `${data.today.fresh} ${unit}`, "fresh");
  metric(metrics, "今日复习", `${data.today.reviewed} ${unit}`, "reviewed");
  metric(metrics, "记录用时", activityDuration(data.today));
  note(today, data.today.attempts ? `共 ${data.today.attempts} 次有效评分，同一内容当天只计一${unit}。` : "今天还没有复习记录，完成一次评分后会显示在这里。");
  if (data.today.timed < data.today.attempts) note(today, `${data.today.attempts - data.today.timed} 次评分没有计时记录，用时仅合计已记录部分。`);
  if (data.today.unclassified) note(today, `另有 ${data.today.unclassified} ${unit}旧记录无法区分新学与复习，已保留在趋势总量中。`);
  help(today, "如何计数与计时？", "按当天第一次有效评分区分新学和复习。重复评分不增加内容数量；已撤销评分不计入。用时合计评分前的记录时间，退出或切到后台暂停计时，每次最多记录 5 分钟；跨午夜完成的练习归入评分当天。旧记录缺少用时时不估算。还未评分的阅读时间不在统计内。");

  const due = section(parent, "到期安排与积压", "根据当前每项内容的下次复习时间安排，后续新学与评分会让图表更新。");
  const totals = due.createDiv({ cls: "review-stats-metrics" });
  metric(totals, "逾期未复习", `${data.overdue} ${unit}`, "overdue");
  metric(totals, "今日剩余到期", `${data.dueToday} ${unit}`);
  metric(totals, "明天到期", `${data.forecast[0].count} ${unit}`, "reviewed");
  choices(due, "到期范围", [[7, "未来 7 天"], [30, "未来 30 天"]], state.forecastDays, (value) => { state.forecastDays = value; changed(); });
  chart(due, data.forecast.slice(0, state.forecastDays).map((d) => ({ date: d.date, segments: [{ value: d.count, kind: "reviewed" }], label: String(d.count), detail: `${d.date} · 已安排 ${d.count} ${unit}到期` })), "每日到期量", unit);
  if (data.overdue) note(due, `已有 ${data.overdue} ${unit}积压，可先处理这些内容，再决定是否增加新学。`);
  help(due, "为什么可能比主页数量多？", "这里显示完整的到期量，不按每日上限截断。逾期指今天以前到期；今日剩余包括今天稍后才到具体时间的内容。只计已开始学习的有效内容，暂停、待确认、移出范围和未学习内容不计入；搁置的内容计入恢复日。每项只统计当前的下一次到期，不预测之后反复练习的次数。");
  if (data.deferred) note(due, `${data.deferred} ${unit}当前已搁置，按可恢复的日期安排。`);
  if (data.invalidDue) note(due, `${data.invalidDue} ${unit}到期时间无效，未计入安排；请到内容管理检查。`);

  const trend = section(parent, "近期复习趋势", "看看最近学了多少、投入多少时间，方便调整学习量。");
  const switches = trend.createDiv({ cls: "review-stats-switches" });
  choices(switches, "趋势范围", [[7, "近 7 天"], [30, "近 30 天"]], state.activityDays, (value) => { state.activityDays = value; changed(); });
  choices(switches, "趋势指标", [["items", "内容数量"], ["time", "记录用时"]], state.activityMetric, (value) => { state.activityMetric = value; changed(); });
  const days = data.activity.slice(-state.activityDays);
  const active = days.filter((day) => day.attempts > 0).length;
  const total = days.reduce((n, day) => n + day.fresh + day.reviewed + day.unclassified, 0);
  const attempts = days.reduce((n, day) => n + day.attempts, 0), timed = days.reduce((n, day) => n + day.timed, 0);
  note(trend, `学习 ${active} / ${state.activityDays} 天 · 每个学习日平均 ${active ? Number((total / active).toFixed(1)) : 0} ${unit} · ${attempts} 次有效评分`);
  if (state.activityMetric === "items") {
    const legend = trend.createDiv({ cls: "review-stats-legend" });
    for (const [cls, text] of [["fresh", "新学"], ["reviewed", "复习"], ...(days.some((d) => d.unclassified) ? [["unknown", "未分类"]] : [])]) legend.createSpan({ cls: `is-${cls}`, text });
  }
  chart(trend, days.map((day) => ({ date: day.date, segments: state.activityMetric === "time" ? [{ value: day.durationMs / 60000, kind: "time" }] : [{ value: day.fresh, kind: "fresh" }, { value: day.reviewed, kind: "reviewed" }, { value: day.unclassified, kind: "unknown" }], label: state.activityMetric === "time" ? (day.attempts && !day.timed ? "—" : String(Number((day.durationMs / 60000).toFixed(1)))) : String(day.fresh + day.reviewed + day.unclassified), detail: dayDetails(day, unit) })), state.activityMetric === "items" ? "每日学习量" : "每日记录用时", state.activityMetric === "items" ? unit : "分钟", true);
  if (timed < attempts) note(trend, `${attempts - timed} 次评分缺少计时记录；用时图只显示已记录部分，“—”表示当天完全未记录用时。`);
  help(trend, "学习量和评分次数有什么区别？", "同一内容一天练习五次，学习量计一项、评分计五次。不同日期再次复习，会分别计入相应日期。未学习的日期也保留在图中。历史归属按评分时的复习组和标签；旧记录缺少归属时按现有标签判断。全部范围保留已删除或移出范围内容的历史。修改统计筛选不改变复习范围和排程。");

  const retention = section(parent, "记忆保留率", "根据你的评分观察延迟回忆效果；默认关注近 30 天，避免被一天的起伏影响。");
  const month = data.retention[1], sample = month.passed + month.failed;
  const rate = (pass: number, fail: number) => pass + fail ? `${Number((pass / (pass + fail) * 100).toFixed(1))}%` : "—";
  const headline = retention.createDiv({ cls: "review-stats-retention" });
  headline.createEl("strong", { text: rate(month.passed, month.failed) });
  headline.createSpan({ text: sample ? `近 30 天 · ${month.passed} / ${sample} 次记得` : "近 30 天暂无符合条件的记录" });
  const table = retention.createEl("table", { cls: "review-stats-table" });
  const header = table.createEl("thead").createEl("tr");
  for (const text of ["时间", "记得", "忘记", "保留率"]) header.createEl("th", { text, attr: { scope: "col" } });
  const body = table.createEl("tbody");
  for (const result of data.retention) {
    const row = body.createEl("tr");
    row.createEl("th", { text: result.days === 365 ? "近一年" : `近 ${result.days} 天`, attr: { scope: "row" } });
    for (const text of [String(result.passed), String(result.failed), rate(result.passed, result.failed)]) row.createEl("td", { text });
  }
  if (!sample) note(retention, "继续跨日复习即可积累数据；暂无记录时显示“—”，不显示为 0%。");
  else if (sample < 30) note(retention, `近 30 天只有 ${sample} 次样本，先观察变化，暂不据此调整记忆率。`);
  else note(retention, "可结合月度结果检查题目是否过长、评分是否一致，再考虑调整复习选项。");
  if (data.retention.some((r) => r.unknown)) note(retention, `近一年有 ${data.retention[2].unknown} 次首次评分无法确定上次练习时间，已排除；不推算缺失历史。`);
  help(retention, "保留率怎么算？", "只统计距上次练习至少 24 小时、当天第一次有效评分的内容。重来表示忘记；困难、良好、简单表示记得。首次新学、短时间内反复练习、撤销的评分不计入。记得次数 ÷（记得 + 忘记次数）。这是基于自评的回忆通过率，笔记模式尤其不代表整篇知识已经完全掌握，也不是 FSRS 预测的回忆概率。");

  if (state.mode === "note" ? settings.showNoteHeatmap : settings.showCardHeatmap) renderStatisticsHeatmap(parent, state.mode, data.history, now);
}

export function renderStatisticsHeatmap(parent: HTMLElement, mode: ReviewMode, history: HistoryEvent[], now: Date): void {
  const days = heatmapDays(history, mode, now);
  const section = parent.createEl("section", { cls: `review-heatmap is-${mode}` });
  const title = mode === "note" ? "笔记复习热力图" : "卡片复习热力图";
  section.createEl("h3", { text: title });
  note(section, `最近一年 · ${days.reduce((sum, day) => sum + day.count, 0)} 次评分 · ${days.filter((day) => day.count > 0).length} 个学习日`);
  const scroll = section.createDiv({ cls: "review-heatmap-scroll", attr: { tabindex: "0", "aria-label": `${title}，可左右滚动` } });
  const chart = scroll.createDiv({ cls: "review-heatmap-chart" });
  const months = chart.createDiv({ cls: "review-heatmap-months", attr: { "aria-hidden": "true" } });
  const grid = chart.createDiv({ cls: "review-heatmap-grid" });
  const first = new Date(`${days[0].date}T12:00:00`), offset = (first.getDay() + 6) % 7;
  months.style.gridTemplateColumns = `repeat(${Math.ceil((offset + days.length) / 7)}, 12px)`;
  for (let i = 0; i < offset; i++) grid.createSpan({ cls: "review-heatmap-empty" });
  const detail = note(section, "点击日期查看次数 · 周一至周日从上到下"); detail.setAttribute("aria-live", "polite");
  days.forEach((day, index) => {
    const date = new Date(`${day.date}T12:00:00`);
    if (date.getDate() === 1) { const month = months.createSpan({ text: `${date.getMonth() + 1}月` }); month.style.gridColumn = String(Math.floor((offset + index) / 7) + 1); }
    const label = `${day.date} · ${day.count} 次评分`;
    const cell = grid.createEl("button", { cls: `review-heatmap-cell level-${day.level}`, attr: { title: label, "aria-label": label, type: "button" } });
    cell.onclick = () => detail.setText(label); cell.onfocus = () => detail.setText(label);
  });
  const legend = section.createDiv({ cls: "review-heatmap-legend" }); legend.createSpan({ text: "评分次数" });
  for (const [level, label] of ["0", "1–5", "6–10", "11–20", "21+"].entries()) { legend.createSpan({ cls: `review-heatmap-swatch level-${level}`, attr: { "aria-hidden": "true" } }); legend.createSpan({ text: label }); }
  window.requestAnimationFrame(() => { if (scroll.isConnected) scroll.scrollLeft = scroll.scrollWidth; });
}
