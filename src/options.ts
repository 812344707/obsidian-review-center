import { Modal, Notice, Platform, Setting } from "obsidian";
import { checkParameters, clipParameters, default_w } from "ts-fsrs";
import type ReviewCenterPlugin from "./main";
import { defaultParameters, groupsFor, nodeParameters, parseSteps, parseTags } from "./config";
import { buildReviewTree, flattenTree, scopeKey } from "./tree";
import { TagInput } from "./inputs";
import { cloneValue, createId, localDayKey } from "./utils";
import type { ReviewCenterSettings, ReviewMode, ReviewParameters, ReviewScope } from "./types";
import { runOptimizer, type OptimizerResult } from "./optimizer";

const signature = (settings: ReviewCenterSettings) => JSON.stringify([settings.noteGroups, settings.cardGroups, settings.presets]);
export class OptionsWorkspace {
  draft: ReviewCenterSettings;
  private baseline: string;
  readonly raw = new Map<string, string>();
  readonly validators = new Map<string, () => void>();
  readonly tabs = new Map<string, string>();
  private cleaners: Array<() => void> = [];
  cancelJob?: () => void;
  busy = false;
  constructor(readonly host: ReviewCenterPlugin) { this.draft = cloneValue(host.settings); this.baseline = signature(host.settings); }
  dispose(): void { this.cleaners.forEach((f) => f()); this.cleaners = []; }
  reset(): void { this.draft = cloneValue(this.host.settings); this.baseline = signature(this.host.settings); this.raw.clear(); this.validators.clear(); }
  async save(): Promise<void> {
    if (this.busy) throw new Error("请等待计算完成或取消计算。");
    if (signature(this.host.settings) !== this.baseline) throw new Error("复习组设置已在别处修改。请还原草稿后重新编辑，避免覆盖新设置。");
    this.validators.forEach((validate) => validate());
    for (const g of [...this.draft.noteGroups, ...this.draft.cardGroups]) if (!g.name.trim()) throw new Error("请输入组名称。");
    await this.host.saveReviewOptions({ ...this.host.settings, noteGroups: this.draft.noteGroups, cardGroups: this.draft.cardGroups, presets: this.draft.presets });
    this.reset();
  }
  renderGroupFields(parent: HTMLElement, scope: ReviewScope): void {
    const group = groupsFor(this.draft, scope.mode).find((g) => g.id === scope.groupId);
    if (!group) return;
    const key = scopeKey({ mode: scope.mode, groupId: scope.groupId }) + ":tags";
    new Setting(parent).setName("组名称").addText((t) => t.setValue(group.name).onChange((v) => { group.name = v; }));
    const tags = new Setting(parent).setName("标签集").setDesc("匹配任意一个，包含子标签。例如 #review 包含 #review/伤寒。");
    let input!: TagInput;
    input = new TagInput(this.host.app, tags.controlEl, group.tags, (v) => { group.tags = v; this.raw.set(key, input.input.value); }, "复习组标签");
    input.input.value = this.raw.get(key) ?? "";
    input.input.oninput = () => this.raw.set(key, input.input.value);
    // Read the shared draft rather than a detached input after switching tabs or groups.
    this.validators.set(key, () => {
      if (!groupsFor(this.draft, scope.mode).includes(group)) return;
      group.tags = parseTags([...group.tags, this.raw.get(key) ?? ""].join("\n"));
      this.raw.delete(key);
    });
    this.cleaners.push(() => input.destroy());
  }
  render(parent: HTMLElement, scope: ReviewScope, redraw: () => void): void {
    this.dispose();
    parent.addClass("review-options-editor");
    const group = groupsFor(this.draft, scope.mode).find((g) => g.id === scope.groupId);
    if (!group) { parent.createEl("p", { text: "该复习组已删除，请重新选择。" }); return; }
    const nodes = group.nodes ??= {}, nodeKey = scope.tagPath ?? "";
    if (!Object.prototype.hasOwnProperty.call(nodes, nodeKey)) Object.defineProperty(nodes, nodeKey, { value: {}, writable: true, enumerable: true, configurable: true });
    const node = nodes[nodeKey];
    const current = nodeParameters(this.draft, scope.mode, group, scope.tagPath ?? "");
    const preset = this.draft.presets?.find((p) => p.id === current.presetId && p.mode === scope.mode);
    if (!preset) { parent.createEl("p", { text: "预设不存在，请重新打开设置。" }); return; }
    const p = preset.parameters, key = scopeKey(scope), presetKey = preset.id;
    const section = (name: string, description: string, folded = false): HTMLElement => {
      const box = parent.createEl(folded ? "details" : "section", { cls: "review-options-section" });
      const title = box.createEl(folded ? "summary" : "h3", { text: name });
      const help = title.createEl("button", { text: "?", cls: "review-option-help", attr: { type: "button", "aria-label": name + "说明" } });
      help.onclick = (e) => { e.preventDefault(); e.stopPropagation(); new Notice(description, 10000); };
      return box;
    };
    const header = section(scope.tagPath ? "#" + scope.tagPath : "组信息与标签", "修改保留为草稿；切换组或关闭窗口不会立即生效。保存会应用本窗口内的全部修改。", true);
    if (!scope.tagPath) {
      this.renderGroupFields(header, scope);
    }
    new Setting(parent).setName("参数预设").setDesc("多个组可以共用一套参数；每日覆盖只影响当前行。").addDropdown((d) => {
      if (scope.tagPath) d.addOption("", "继承父级预设");
      for (const item of this.draft.presets ?? []) if (item.mode === scope.mode) d.addOption(item.id, item.name);
      d.setValue(scope.tagPath ? node.presetId ?? "" : group.presetId ?? "").onChange((id) => {
        if (scope.tagPath) node.presetId = id || undefined; else group.presetId = id;
        redraw();
      });
    }).addButton((b) => b.setButtonText("复制为新预设").onClick(() => {
      try { this.validators.forEach((v) => v()); } catch (e) { new Notice(String(e)); return; }
      const copy = { ...cloneValue(preset), id: createId("preset"), name: preset.name + " 副本" };
      (this.draft.presets ??= []).push(copy);
      if (scope.tagPath) node.presetId = copy.id; else group.presetId = copy.id;
      redraw();
    }));
    new Setting(header).setName("预设名称").addText((t) => t.setValue(preset.name).onChange((v) => { preset.name = v || "未命名预设"; }));
    const text = (box: HTMLElement, label: string, field: keyof ReviewParameters, desc: string, parse: (v: string) => unknown, value?: string) => {
      const id = presetKey + ":" + field;
      const initial = value ?? String(p[field] ?? "");
      new Setting(box).setName(label).setDesc(desc).addText((t) => {
        t.setValue(this.raw.get(id) ?? initial).onChange((v) => { this.raw.set(id, v); });
      });
      this.validators.set(id, () => { if (this.raw.has(id)) (p as unknown as Record<string, unknown>)[field] = parse(this.raw.get(id)!); });
    };
    const numeric = (box: HTMLElement, label: string, field: keyof ReviewParameters, min: number, max: number, desc: string) => text(box, label, field, desc, (v) => validNumber(v, min, max));
    const toggle = (box: HTMLElement, label: string, field: keyof ReviewParameters, desc = "") => new Setting(box).setName(label).setDesc(desc).addToggle((t) => t.setValue(p[field] === true).onChange((v) => { (p as unknown as Record<string, unknown>)[field] = v; }));
    const select = (box: HTMLElement, label: string, field: keyof ReviewParameters, choices: string[][]) => new Setting(box).setName(label).addDropdown((d) => {
      for (const [id, name] of choices) d.addOption(id, name);
      d.setValue(String(p[field] ?? choices[0][0])).onChange((v) => { (p as unknown as Record<string, unknown>)[field] = v; });
    });
    const limits = section("每日上限", "每天最多开始或复习多少项。同一内容当天重复练习只占一次额度；数字为 0 时停止引入该类内容。");
    for (const [field, label] of [["newLimit", "每日新内容"], ["reviewLimit", "每日到期复习"]] as const) {
      const id = key + ":" + field, selectedTab = this.tabs.get(id) ?? "preset";
      const row = new Setting(limits).setName(label).setDesc(field === "newLimit" ? "每天最多开始学习多少篇笔记或多少张新卡片" : "每天最多复习多少项到期内容，同一项当天重复练习只占一次额度");
      const controls = row.controlEl.createDiv({ cls: "review-option-limit" });
      const tabs = controls.createDiv({ cls: "review-option-tabs" });
      for (const [tab, name] of [["preset", "预设配置"], ["node", "当前组"], ["today", "仅限今日"]]) {
        const b = tabs.createEl("button", { text: name, cls: tab === selectedTab ? "is-active" : "", attr: { "aria-pressed": String(tab === selectedTab) } });
        b.onclick = () => { this.tabs.set(id, tab); redraw(); };
      }
      const maximum = field === "newLimit" ? (scope.mode === "note" ? 999 : 9999) : (scope.mode === "note" ? 9999 : 99999);
      const rawKey = selectedTab === "preset" ? presetKey + ":limit:" + field : id + ":" + selectedTab;
      const value = selectedTab === "preset" ? p[field] : selectedTab === "node" ? node.limits?.[field] : node.today?.date === localDayKey(new Date()) ? node.today[field] : undefined;
      const input = controls.createEl("input", { type: "number", value: this.raw.get(rawKey) ?? (value === undefined ? "" : String(value)), placeholder: "继承：" + current.parameters[field], attr: { min: "0", max: String(maximum), "aria-label": label + " " + selectedTab } });
      input.oninput = () => this.raw.set(rawKey, input.value);
      this.validators.set(rawKey, () => {
        if (!this.raw.has(rawKey)) return;
        const raw = this.raw.get(rawKey)!;
        const parsed = raw.trim() === "" && selectedTab !== "preset" ? undefined : validNumber(raw, 0, maximum);
        if (selectedTab === "preset") p[field] = parsed!;
        else if (selectedTab === "node") (node.limits ??= {})[field] = parsed;
        else { if (node.today?.date !== localDayKey(new Date())) node.today = { date: localDayKey(new Date()) }; node.today![field] = parsed; }
      });
      controls.createEl("button", { text: "↺", attr: { "aria-label": "重置" + label, title: selectedTab === "preset" ? "恢复默认值" : "清除覆盖，继承预设" } }).onclick = () => {
        this.raw.set(rawKey, selectedTab === "preset" ? String(defaultParameters(scope.mode)[field]) : ""); this.validators.get(rawKey)!(); redraw();
      };
    }
    toggle(limits, "新内容独立于复习上限", "newIgnoreReviewLimit", "关闭后，新内容也占用每日复习额度。");
    toggle(limits, "使用顶层组的上限", "limitsFromTop", "从子标签开始时，也遵守顶层复习组的每日额度。");
    const memory = section("FSRS", "希望下次复习时仍能记住的比例；调高通常需要更频繁地复习。所有复习固定使用 FSRS。");
    const retentionTab = this.tabs.get(key + ":retention") ?? "preset";
    const retentionSetting = new Setting(memory).setName("目标记忆率（%）").setDesc("希望下次复习时仍能记住的比例；调高通常需要更频繁地复习");
    retentionSetting.addDropdown((d) => d.addOption("preset", "预设配置").addOption("node", "当前组").setValue(retentionTab).onChange((v) => { this.tabs.set(key + ":retention", v); redraw(); }));
    const rKey = retentionTab === "preset" ? presetKey + ":retention" : key + ":retention:node";
    retentionSetting.addText((t) => t.setValue(this.raw.get(rKey) ?? String(Math.round((retentionTab === "preset" ? p.retention : node.retention ?? current.parameters.retention) * 100))).onChange((v) => this.raw.set(rKey, v)));
    this.validators.set(rKey, () => { if (!this.raw.has(rKey)) return; const v = this.raw.get(rKey)!; if (!v.trim() && retentionTab === "node") node.retention = undefined; else { const n = validNumber(v, 70, 99) / 100; if (retentionTab === "preset") p.retention = n; else node.retention = n; } });
    const advanced = memory.createEl("details", { cls: "review-options-more" }); advanced.createEl("summary", { text: "更多参数与优化" });
    numeric(advanced, "最大间隔（天）", "maximumInterval", 1, 36500, "两次复习之间最长允许隔多少天");
    const weightsKey = presetKey + ":weights";
    new Setting(advanced).setName("FSRS 参数").setDesc("21 个数字，用逗号或空格分隔；留空恢复算法默认值。").addTextArea((t) => t.setValue(this.raw.get(weightsKey) ?? p.weights?.join(", ") ?? "").setPlaceholder(default_w.join(", ")).onChange((v) => this.raw.set(weightsKey, v)));
    this.validators.set(weightsKey, () => {
      if (!this.raw.has(weightsKey)) return;
      const raw = this.raw.get(weightsKey)!.trim();
      if (!raw) { p.weights = undefined; return; }
      const w = raw.split(/[\s,，]+/).map(Number);
      if (w.length !== 21 || w.some((n) => !Number.isFinite(n))) throw new Error("FSRS 参数需要 21 个有效数字。");
      checkParameters(w);
      const clipped = clipParameters(w, p.relearningSteps.length);
      if (w.some((n, i) => Math.abs(n - clipped[i]) > 0.000001)) throw new Error("FSRS 参数超出算法支持范围，请检查输入或使用本地优化结果。");
      p.weights = w;
    });
    text(advanced, "优化历史筛选", "historyFilter", '支持 preset:"预设名"、tag:标签、path:路径、is:suspended 及前缀 - 排除条件；条件之间为同时满足。', (v) => v);
    toggle(advanced, "更改时重新排程", "rescheduleOnChange", "默认关闭。开启后先展示影响数量并备份，再调整现有到期时间。");
    toggle(advanced, "优化时检查健康状况", "healthCheck", "按历史时间分段评估，耗时较长。");
    const status = advanced.createDiv({ cls: "review-optimizer-status", attr: { role: "status", "aria-live": "polite" } });
    const jobButtons = advanced.createDiv({ cls: "review-options-job-buttons" });
    const optimize = async (action: "optimize" | "retention", all = false) => {
      if (this.busy) return;
      try {
        this.validators.forEach((v) => v());
        this.busy = true; status.empty();
        const list = all ? this.draft.presets!.filter((p) => p.mode === scope.mode) : [preset];
        for (const target of list) {
          const message = status.createEl("p", { text: target.name + "：准备历史…" });
          const job = runOptimizer(this.host, this.draft, target, action, (label) => { message.setText(target.name + "：" + label); });
          this.cancelJob = job.cancel;
          try {
            const result = await job.result;
            if (action === "optimize" && result.weights) {
              target.parameters.weights = result.weights; this.raw.set(target.id + ":weights", result.weights.join(", "));
              message.setText(`${target.name}：${result.samples} 条跨日记录；误差 ${result.before?.logLoss.toFixed(3)} → ${result.after?.logLoss.toFixed(3)}。结果已放入草稿，保存后应用。${result.health ? " 已完成分段检查。" : result.healthError ? " 分段检查未完成：" + result.healthError : ""}`);
            } else { message.setText(target.name + "：模拟完成。"); this.renderSimulation(status, result, (retention) => { p.retention = retention; this.raw.set(presetKey + ":retention", String(Math.round(retention * 100))); new Notice("建议记忆率已放入预设草稿"); }); }
          } catch (error) { message.setText(target.name + "：" + String(error)); if (String(error).includes("取消")) break; }
        }
      } catch (error) { status.setText(String(error)); }
      finally { this.busy = false; this.cancelJob = undefined; }
    };
    for (const [label, action, all] of [["优化当前预设", "optimize", false], ["优化所有预设", "optimize", true], ["帮我决定（实验性）", "retention", false]] as const) {
      const b = jobButtons.createEl("button", { text: label }); b.disabled = Platform.isMobile;
      b.onclick = () => void optimize(action, all);
    }
    jobButtons.createEl("button", { text: "取消计算" }).onclick = () => this.cancelJob?.();
    if (Platform.isMobile) advanced.createEl("p", { cls: "setting-item-description", text: "电脑负责本地优化；手机可以使用已同步的结果或手动编辑参数。" });
    const fresh = section("新内容", "学习步长决定新内容第一次学习后，隔多久再次练习。", true);
    text(fresh, "学习步长", "learningSteps", "例如 1m 10m 表示 1 分钟、10 分钟；留空交给 FSRS 安排。", parseSteps, p.learningSteps.join(" "));
    select(fresh, "插入位置", "insertion", [["sequential", "顺序插入（旧内容在前）"], ["random", "随机插入"]]);
    const lapses = section("遗忘", "重学步长决定选择“重来”后多久再次练习。记忆难点是内部标记，不修改原笔记标签。", true);
    text(lapses, "重学步长", "relearningSteps", "例如 10m 表示 10 分钟。", parseSteps, p.relearningSteps.join(" "));
    numeric(lapses, "记忆难点阈值", "leechThreshold", 1, 999, "累计遗忘达到多少次后标记为记忆难点");
    select(lapses, "记忆难点处理", "leechAction", [["tag", "仅标记"], ["suspend", "标记并暂停复习"]]);
    const order = section("展示顺序", "只影响出题顺序，不改变卡片进度。随机顺序在当前会话及继续复习时保持一致。", true);
    select(order, "新内容抽取顺序", "newGather", [["group", "按组顺序"], ["created", "创建时间：旧到新"], ["created-desc", "创建时间：新到旧"], ["random-note", "随机笔记"], ["random-card", "随机内容"]]);
    select(order, "新内容排列顺序", "newSort", scope.mode === "card" ? [["gather", "按抽取顺序"], ["type", "先按卡片类型，再按抽取顺序"], ["random-note", "按笔记随机，再按卡片类型"], ["random", "完全随机"]] : [["gather", "按抽取顺序"], ["random", "随机"]]);
    select(order, "新学与复习先后", "newOrder", [["before", "新内容在前"], ["mixed", "学新与复习混合"], ["after", "新内容在后"]]);
    select(order, "跨日学习展示顺序", "interdayOrder", [["before", "跨日学习在复习前"], ["mixed", "与复习混合"], ["after", "跨日学习在复习后"]]);
    select(order, "到期内容排列顺序", "reviewSort", [["due", "按到期时间"], ["due-random", "先到期日期，再随机"], ["group", "先组顺序，再到期时间"], ["interval", "间隔：短到长"], ["interval-desc", "间隔：长到短"], ["difficulty", "难度：低到高"], ["difficulty-desc", "难度：高到低"], ["retention", "记忆率：低到高"], ["retention-desc", "记忆率：高到低"], ["random", "随机"]]);
    if (scope.mode === "card") {
      const bury = section("关联卡搁置", "关联卡仅为同一挖空块生成的 c1、c2 等卡片，复习其中一张后将关联卡暂时移出今日队列，次日自动恢复。", true);
      toggle(bury, "搁置新的关联卡到次日", "buryNew"); toggle(bury, "搁置待复习的关联卡到次日", "buryReview"); toggle(bury, "搁置跨日学习的关联卡到次日", "buryInterday");
    }
    const error = parent.createDiv({ cls: "review-setting-error", attr: { role: "alert" } });
    const save = new Setting(parent).setName("保存修改").setDesc("切换组保留草稿。保存后应用所有已编辑的组和预设；默认不改变已有到期时间。");
    save.addButton((b) => b.setButtonText("还原草稿").onClick(() => { if (!this.busy) { this.reset(); redraw(); } }));
    save.addButton((b) => b.setButtonText("保存").setCta().onClick(() => {
      b.setDisabled(true); void this.save().then(() => { redraw(); new Notice("复习选项已保存"); }).catch((e) => error.setText(String(e))).finally(() => b.setDisabled(false));
    }));
  }
  private renderSimulation(parent: HTMLElement, result: OptimizerResult, apply: (value: number) => void): void {
    parent.createEl("p", { text: `按当前预设和历史评分习惯，模拟 ${result.deckSize} 项内容从新学开始的一年。未设置每日时长上限；${result.missingTime ?? 0} 条历史缺少用时，采用算法默认用时估算。` });
    const table = parent.createEl("table", { cls: "review-simulation-table" });
    const head = table.createEl("tr"); ["目标记忆率", "平均分钟/天", "平均复习项/天"].forEach((t) => head.createEl("th", { text: t }));
    for (const row of result.rows ?? []) { const tr = table.createEl("tr"); [Math.round(row.retention * 100) + "%", row.minutesPerDay.toFixed(1), row.reviewsPerDay.toFixed(1)].forEach((t) => tr.createEl("td", { text: t })); }
    if (result.recommended) {
      const value = Math.round(result.recommended * 100) / 100;
      parent.createEl("button", { text: `采用建议 ${Math.round(value * 100)}%` }).onclick = () => apply(value);
      parent.createEl("p", { text: "建议以记住每项内容所需的时间较少为目标；结果是估算，保存后才会应用。", cls: "setting-item-description" });
    }
  }
}
export class ReviewOptionsModal extends Modal {
  private reviewScope: ReviewScope;
  constructor(readonly host: ReviewCenterPlugin, reviewScope: ReviewScope) { super(host.app); this.reviewScope = { ...reviewScope }; }
  onOpen(): void { this.modalEl.addClass("review-options-modal"); this.draw(); }
  onClose(): void { this.host.optionsWorkspace.dispose(); }
  private draw(): void {
    this.contentEl.empty(); this.titleEl.setText("复习选项");
    const select = new Setting(this.contentEl).setName("正在设置");
    select.addDropdown((d) => d.addOption("note", "笔记").addOption("card", "卡片").setValue(this.reviewScope.mode).onChange((v) => {
      const mode = v as ReviewMode, group = groupsFor(this.host.optionsWorkspace.draft, mode)[0]; if (group) { this.reviewScope = { mode, groupId: group.id }; this.draw(); }
    }));
    const nodes = flattenTree(buildReviewTree(this.host.service.records, this.host.optionsWorkspace.draft, this.reviewScope.mode));
    select.addDropdown((d) => { nodes.forEach((n) => d.addOption(n.id, n.tagPath ? "　#" + n.tagPath : n.label)); d.setValue(scopeKey(this.reviewScope)).onChange((v) => { const node = nodes.find((n) => n.id === v); if (node) { this.reviewScope = node; this.draw(); } }); });
    this.host.optionsWorkspace.render(this.contentEl.createDiv(), this.reviewScope, () => this.draw());
  }
}
export class ConfirmActionModal extends Modal {
  constructor(host: ReviewCenterPlugin, private readonly title: string, private readonly description: string, private readonly action: () => Promise<void>, private readonly onCancel?: () => void) { super(host.app); }
  private accepted = false;
  onOpen(): void {
    this.titleEl.setText(this.title); this.contentEl.createEl("p", { text: this.description });
    const error = this.contentEl.createEl("p", { attr: { role: "alert" } });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("取消").onClick(() => this.close())).addButton((b) => b.setButtonText("确认执行").setCta().onClick(() => { b.setDisabled(true); void this.action().then(() => { this.accepted = true; this.close(); }).catch((e) => { error.setText(String(e)); b.setDisabled(false); }); }));
  }
  onClose(): void { if (!this.accepted) this.onCancel?.(); }
}
export class RenameGroupModal extends Modal {
  constructor(private readonly host: ReviewCenterPlugin, private readonly reviewScope: ReviewScope) { super(host.app); }
  onOpen(): void {
    const group = groupsFor(this.host.settings, this.reviewScope.mode).find((g) => g.id === this.reviewScope.groupId); if (!group) return;
    this.titleEl.setText("重命名复习组"); let name = group.name;
    new Setting(this.contentEl).setName("名称").addText((t) => t.setValue(name).onChange((v) => { name = v; }));
    const error = this.contentEl.createEl("p", { attr: { role: "alert" } });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("保存").setCta().onClick(() => {
      if (!name.trim()) { error.setText("请输入名称。"); return; }
      const next = cloneValue(this.host.settings); groupsFor(next, this.reviewScope.mode).find((g) => g.id === group.id)!.name = name.trim();
      void this.host.updateSettings(next).then(() => this.close()).catch((e) => error.setText(String(e)));
    }));
  }
}
function validNumber(raw: string, min: number, max: number): number {
  const value = Number(raw); if (!raw.trim() || !Number.isInteger(value) || value < min || value > max) throw new Error(`请输入 ${min}–${max} 之间的整数。`); return value;
}
