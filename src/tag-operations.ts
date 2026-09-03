import { getAllTags, getFrontMatterInfo, Modal, Notice, Setting, type App, type ButtonComponent, type CachedMetadata } from "obsidian";
import { parseDocument } from "yaml";
import type ReviewCenterPlugin from "./main";
import type { ReviewCenterSettings, ReviewScope } from "./types";
import { normalizeTags, parseTags, tagMatches } from "./config";
import { cloneValue, createId, pathIsInside } from "./utils";
import { TagInput } from "./inputs";
export interface TagOperation { from: string; to?: string }
export interface TagFileChange {
  path: string; original: string; next: string; selected: boolean; changes: string[];
  status?: "done" | "failed"; error?: string;
}
export interface TagJob { kind: "tags"; state: "pending" | "done"; createdAt: string; operation: TagOperation; files: TagFileChange[]; backup?: string; settingsApplied?: boolean; remaining?: number }
export function validateTagOperation(operation: TagOperation): TagOperation {
  const from = parseTags(operation.from), to = operation.to === undefined ? undefined : parseTags(operation.to);
  if (from.length !== 1 || (to && to.length !== 1)) throw new Error("请输入一个完整标签路径。");
  if (to && tagMatches(to[0], from[0])) throw new Error("新标签须与原标签不同，且不能移到自身子级。");
  return { from: from[0], to: to?.[0] };
}
function replacement(tag: string, op: TagOperation): string | undefined { return op.to === undefined ? undefined : op.to + tag.slice(op.from.length); }
export function transformTags(markdown: string, cache: Pick<CachedMetadata, "tags">, op: TagOperation): { text: string; changes: string[] } {
  const info = getFrontMatterInfo(markdown), changes: string[] = [];
  if (/^(?:\uFEFF)?---\r?\n/.test(markdown) && !info.exists) throw new Error("笔记属性没有正确结束，已跳过。");
  const document = info.exists ? parseDocument(info.frontmatter) : undefined;
  if (document?.errors.length) throw new Error("笔记属性无法解析，已跳过。");
  const properties = document?.toJS({ maxAliasCount: 100 });
  if (properties != null && (typeof properties !== "object" || Array.isArray(properties))) throw new Error("笔记属性不是键值列表，已跳过。");
  const property = properties?.tags;
  if (property != null && typeof property !== "string" && !(Array.isArray(property) && property.every((v) => typeof v === "string"))) throw new Error("tags 属性不是文字或文字列表，已跳过。");
  const values: string[] = typeof property === "string" ? property.split(/[\s,，]+/).filter(Boolean) : property ?? [];
  let changedProperty = false;
  const mapped = values.flatMap((tag) => {
    const normalized = normalizeTags([tag])[0];
    if (!normalized || !tagMatches(normalized, op.from)) return [tag];
    changedProperty = true; const next = replacement(normalized, op);
    changes.push("属性 #" + normalized + " → " + (next ? "#" + next : "删除")); return next ? [next] : [];
  });
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const destinations = new Set((cache.tags ?? []).map((t) => normalizeTags([t.tag])[0]).filter((t) => !tagMatches(t, op.from)));
  for (const tag of cache.tags ?? []) {
    const normalized = normalizeTags([tag.tag])[0];
    if (!tagMatches(normalized, op.from)) continue;
    const start = tag.position.start.offset, end = tag.position.end.offset;
    if (markdown.slice(start, end) !== tag.tag) throw new Error("正文标签索引已变化，请等待索引完成后重新预览。");
    if (info.exists && start < info.contentStart) continue;
    if (edits.some((e) => e.start === start)) continue;
    const next = replacement(normalized, op), duplicate = next && destinations.has(next);
    edits.push({ start, end, value: next && !duplicate ? "#" + next : "" });
    if (next) destinations.add(next);
    changes.push("正文 #" + normalized + " → " + (next ? "#" + next : "删除"));
  }
  let text = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  if (changedProperty && document) {
    const seen = new Set<string>(); const unique = mapped.filter((tag) => { const n = normalizeTags([tag])[0]; if (seen.has(n)) return false; seen.add(n); return true; });
    document.set("tags", unique);
    const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
    text = text.slice(0, info.from) + document.toString().replace(/\r?\n/g, newline) + text.slice(info.to);
  }
  return { text, changes };
}
export async function previewTagOperation(app: App, settings: ReviewCenterSettings, operation: TagOperation): Promise<TagFileChange[]> {
  const op = validateTagOperation(operation), results: TagFileChange[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (pathIsInside(file.path, settings.dataFolder)) continue;
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) throw new Error("标签索引尚未完成，请稍后重新预览。");
    if (!normalizeTags(getAllTags(cache) ?? []).some((tag) => tagMatches(tag, op.from))) continue;
    const entry: TagFileChange = { path: file.path, original: "", next: "", selected: true, changes: [] };
    try { entry.original = await app.vault.read(file); const transformed = transformTags(entry.original, cache, op); entry.next = transformed.text; entry.changes = transformed.changes; }
    catch (e) { entry.error = String(e); entry.selected = false; }
    results.push(entry);
  }
  return results.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
}
export function rewriteTagReferences(settings: ReviewCenterSettings, operation: TagOperation, keepOld: boolean): ReviewCenterSettings {
  const next = cloneValue(settings), op = validateTagOperation(operation);
  for (const group of [...next.noteGroups, ...next.cardGroups]) {
    group.tags = normalizeTags(group.tags.flatMap((tag) => {
      if (tagMatches(tag, op.from)) { const updated = replacement(tag, op); return [...(keepOld ? [tag] : []), ...(updated ? [updated] : [])]; }
      if (op.to && tagMatches(op.from, tag) && !tagMatches(op.to, tag)) return [tag, op.to];
      return [tag];
    }));
    for (const [path, node] of Object.entries(group.nodes ?? {})) if (tagMatches(path, op.from)) {
      const updated = replacement(path, op);
      if (updated && !group.nodes![updated]) group.nodes![updated] = cloneValue(node);
      if (!keepOld) delete group.nodes![path];
    }
  }
  return next;
}
export async function runTagJob(host: ReviewCenterPlugin, id: string, job: TagJob): Promise<void> {
  await host.service.runMaintenance(async () => {
    if (!job.backup) {
      job.backup = await host.store.writeBackup({ schemaVersion: 4, kind: "full", exportedAt: new Date().toISOString(), pluginVersion: host.manifest.version,
        settings: cloneValue(host.settings), records: cloneValue(host.service.records), history: cloneValue(host.service.history) }, "pre-tag-operation");
      // Originals live in this immutable journal before the first note is changed.
      await host.store.saveJob(id, job);
    }
    for (const entry of job.files.filter((e) => e.selected && e.status !== "done")) {
      try {
        const file = host.app.vault.getMarkdownFiles().find((f) => f.path === entry.path);
        if (!file || pathIsInside(entry.path, host.settings.dataFolder)) throw new Error("文件已移动、删除或进入数据目录。");
        await host.app.vault.process(file, (current) => {
          if (current === entry.next) return current; // Recovery after the write but before its checkpoint.
          if (current !== entry.original) throw new Error("笔记在预览后发生修改，请重新预览。");
          return entry.next;
        });
        if (await host.app.vault.read(file) !== entry.next) throw new Error("写入后核对不一致。");
        entry.status = "done"; delete entry.error;
      } catch (e) { entry.status = "failed"; entry.error = String(e); }
      await host.store.saveJob(id, job);
    }
    let remaining = job.files.filter((e) => e.status !== "done").length;
    const paths = new Set(job.files.map((e) => e.path));
    for (const file of host.app.vault.getMarkdownFiles()) if (!paths.has(file.path) && !pathIsInside(file.path, host.settings.dataFolder)) {
      const cache = host.app.metadataCache.getFileCache(file);
      if (!cache) { remaining++; continue; }
      const tags = normalizeTags(getAllTags(cache) ?? []);
      if (tags.some((tag) => tagMatches(tag, job.operation.from))) remaining++;
    }
    const next = rewriteTagReferences(host.settings, job.operation, remaining > 0);
    await host.persistSettingsInMaintenance(next);
    if (host.service.session?.tagPath && tagMatches(host.service.session.tagPath, job.operation.from) && remaining === 0) {
      host.service.session.tagPath = job.operation.to ? replacement(host.service.session.tagPath, job.operation) : undefined;
    }
    job.settingsApplied = true; job.remaining = remaining;
    job.state = job.files.some((e) => e.selected && e.status === "failed") ? "pending" : "done";
    await host.store.saveJob(id, job);
  });
  await host.refreshData();
}
export class TagOperationModal extends Modal {
  private files: TagFileChange[] = [];
  private input?: TagInput;
  private operation: TagOperation;
  private busy = false;
  private previewVersion = 0;
  constructor(readonly host: ReviewCenterPlugin, scope: ReviewScope, rename: boolean) {
    super(host.app); this.operation = { from: scope.tagPath!, ...(rename ? { to: "" } : {}) };
  }
  onOpen(): void {
    this.modalEl.addClass("review-tag-operation-modal"); this.titleEl.setText(this.operation.to === undefined ? "删除标签" : "重命名标签");
    this.contentEl.createEl("p", { text: `整个知识库中的 #${this.operation.from} 及子标签。属性与正文标签同步修改；删除标签不会删除笔记。` });
    let execute: ButtonComponent;
    const preview = this.contentEl.createDiv();
    const invalidate = () => { this.previewVersion++; this.files = []; preview.empty(); if (execute) execute.setDisabled(true); };
    if (this.operation.to !== undefined) {
      const row = new Setting(this.contentEl).setName("新标签");
      this.input = new TagInput(this.app, row.controlEl, [], invalidate, "新标签");
      this.input.input.addEventListener("input", invalidate);
    }
    this.contentEl.appendChild(preview);
    const controls = new Setting(this.contentEl);
    const message = this.contentEl.createDiv({ attr: { role: "status" } });
    controls.addButton((b) => b.setButtonText("预览受影响笔记").onClick(() => {
      if (this.busy) return;
      void (async () => {
        try {
          this.busy = true; b.setDisabled(true); execute.setDisabled(true);
          if (this.input) { const values = this.input.values(); if (values.length !== 1) throw new Error("请选择一个新标签。"); this.operation.to = values[0]; }
          this.operation = validateTagOperation(this.operation);
          const version = this.previewVersion;
          const files = await previewTagOperation(this.app, this.host.settings, this.operation);
          if (version !== this.previewVersion) throw new Error("标签已修改，请重新预览。");
          this.files = files;
          preview.empty(); preview.createEl("p", { text: `匹配 ${this.files.length} 篇笔记，可取消个别文件。` });
          const related = [...this.host.settings.noteGroups, ...this.host.settings.cardGroups].filter((g) => g.tags.some((t) => tagMatches(t, this.operation.from) || tagMatches(this.operation.from, t)));
          preview.createEl("p", { text: "关联复习组：" + (related.map((g) => g.name).join("、") || "无") });
          for (const file of this.files) {
            const row = preview.createEl("details", { cls: "review-tag-file" }), title = row.createEl("summary");
            const checkbox = title.createEl("input", { type: "checkbox", attr: { "aria-label": file.path } }); checkbox.checked = file.selected; checkbox.disabled = !!file.error;
            checkbox.onclick = (e) => e.stopPropagation(); checkbox.onchange = () => { file.selected = checkbox.checked; };
            title.createSpan({ text: file.path });
            row.createEl("pre", { text: file.error ?? file.changes.join("\n") });
          }
          execute.setDisabled(false); message.setText("确认后先备份，再执行以上更改。");
        } catch (e) { message.setText(String(e)); } finally { this.busy = false; b.setDisabled(false); }
      })();
    }));
    controls.addButton((b) => { b.setButtonText("确认并执行").setCta().setDisabled(true); execute = b; b.onClick(() => {
      if (this.busy) return;
      void (async () => {
        this.busy = true; b.setDisabled(true);
        try {
          const id = createId("tags"), job: TagJob = { kind: "tags", state: "pending", createdAt: new Date().toISOString(), operation: { ...this.operation }, files: cloneValue(this.files) };
          await runTagJob(this.host, id, job);
          message.setText(`完成 ${job.files.filter((f) => f.status === "done").length} 篇；失败 ${job.files.filter((f) => f.status === "failed").length} 篇；${job.remaining ?? 0} 篇保留旧标签。备份与原文：${this.host.settings.dataFolder}/operations/${id}`);
          for (const file of job.files.filter((f) => f.error)) message.createEl("p", { text: file.path + "：" + file.error });
          new Notice("标签操作已完成，可在设置中查看记录或继续失败项。");
        } catch (e) { message.setText(String(e)); } finally { this.busy = false; }
      })();
    }); });
  }
  onClose(): void { this.input?.destroy(); }
}
