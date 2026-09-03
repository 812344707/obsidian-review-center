import { App, normalizePath } from "obsidian";
import type {
  FullBackup,
  HistoryEvent,
  ReviewCenterSettings,
  SourceRecord,
} from "./types";
import { createId, hashText, localDayKey } from "./utils";

export class ReviewStore {
  private writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => ReviewCenterSettings,
    readonly sessionId: string,
    readonly deviceId: string,
  ) {}

  async initialize(): Promise<void> {
    await this.ensureFolder(this.baseFolder());
    await this.ensureFolder(this.recordsFolder());
    await this.ensureFolder(this.historyFolder());
    await this.ensureFolder(this.exportsFolder());
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writeChains.values()]);
  }

  async backupSource(sourcePath: string, markdown: string, record?: SourceRecord): Promise<void> {
    const folder = normalizePath(this.baseFolder() + "/migrations/callouts");
    await this.ensureFolder(folder);
    let path = folder + "/" + hashText(sourcePath + "\n" + markdown) + ".json";
    if (await this.app.vault.adapter.exists(path)) {
      const previous = JSON.parse(await this.app.vault.adapter.read(path)) as { sourcePath?: string; markdown?: string };
      if (previous.sourcePath === sourcePath && previous.markdown === markdown) return;
      path = folder + "/" + createId("source-backup") + ".json";
    }
    const payload = JSON.stringify({ sourcePath, markdown, record, backedUpAt: new Date().toISOString() }, null, 2);
    await this.app.vault.adapter.write(path, payload);
    if (await this.app.vault.adapter.read(path) !== payload) throw new Error("原文备份核对失败，未转换笔记。");
  }

  async saveJob(id: string, data: unknown): Promise<void> {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("操作标识无效。");
    const folder = this.baseFolder() + "/operations/" + id;
    await this.ensureFolder(folder);
    const files = await this.listFilesRecursively(folder);
    const sequence = Math.max(0, ...files.map((path) => Number(path.split("/").pop()?.replace(".json", "")) || 0)) + 1;
    const path = folder + "/" + String(sequence).padStart(8, "0") + ".json";
    const text = JSON.stringify(data);
    await this.app.vault.adapter.write(path, text);
    if (await this.app.vault.adapter.read(path) !== text) throw new Error("操作记录写入校验失败，已停止。");
  }
  async loadJobs<T>(): Promise<Array<{ id: string; data: T }>> {
    const files = (await this.listFilesRecursively(this.baseFolder() + "/operations")).filter((p) => p.endsWith(".json")).sort().reverse();
    const jobs = new Map<string, T>();
    for (const path of files) {
      const id = path.split("/").at(-2)!; if (jobs.has(id)) continue;
      try { jobs.set(id, JSON.parse(await this.app.vault.adapter.read(path)) as T); }
      catch { console.warn("[复习中心] 中断的操作记录，读取前一版本", path); }
    }
    return [...jobs].map(([id, data]) => ({ id, data }));
  }

  async loadRecord(reviewId: string): Promise<SourceRecord | null> {
    const path = this.recordPath(reviewId);
    if (!(await this.app.vault.adapter.exists(path))) return null;
    try {
      return JSON.parse(await this.app.vault.adapter.read(path)) as SourceRecord;
    } catch (error) {
      console.error(`[复习中心] 无法读取记录 ${path}`, error);
      return null;
    }
  }

  async saveRecord(record: SourceRecord): Promise<void> {
    const path = this.recordPath(record.reviewId);
    await this.ensureFolder(parentPath(path));
    await this.serializeWrite(path, async () => {
      await this.app.vault.adapter.write(path, `${JSON.stringify(record, null, 2)}\n`);
    });
  }

  async deleteRecord(reviewId: string): Promise<void> {
    const path = this.recordPath(reviewId);
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }

  async loadAllRecords(): Promise<SourceRecord[]> {
    const files = await this.listFilesRecursively(this.recordsFolder());
    const records: SourceRecord[] = [];
    for (const path of files.filter((file) => file.endsWith(".json"))) {
      try {
        records.push(JSON.parse(await this.app.vault.adapter.read(path)) as SourceRecord);
      } catch (error) {
        console.error(`[复习中心] 跳过损坏的记录 ${path}`, error);
      }
    }
    return records;
  }

  async appendHistory(events: HistoryEvent[]): Promise<void> {
    if (events.length === 0) return;
    const month = localDayKey(new Date()).slice(0, 7);
    const folder = normalizePath(`${this.historyFolder()}/${month}`);
    await this.ensureFolder(folder);
    const path = normalizePath(`${folder}/${this.sessionId}.jsonl`);
    const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await this.serializeWrite(path, async () => {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.append(path, payload);
      } else {
        await this.app.vault.adapter.write(path, payload);
      }
    });
  }

  async loadAllHistory(): Promise<HistoryEvent[]> {
    const files = await this.listFilesRecursively(this.historyFolder());
    const events: HistoryEvent[] = [];
    for (const path of files.filter((file) => file.endsWith(".jsonl"))) {
      let text: string;
      try {
        text = await this.app.vault.adapter.read(path);
      } catch (error) {
        console.error(`[复习中心] 无法读取历史 ${path}`, error);
        continue;
      }
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const event = JSON.parse(line) as HistoryEvent;
          if (event.schemaVersion === 1 && event.eventId) events.push(event);
        } catch (error) {
          console.error(`[复习中心] 跳过损坏的历史行 ${path}`, error);
        }
      }
    }
    return deduplicateEvents(events);
  }

  async replaceHistory(events: HistoryEvent[]): Promise<void> {
    const files = await this.listFilesRecursively(this.historyFolder());
    for (const path of files.filter((file) => file.endsWith(".jsonl"))) {
      await this.app.vault.adapter.remove(path);
    }
    if (events.length === 0) return;
    const month = localDayKey(new Date()).slice(0, 7);
    const folder = normalizePath(`${this.historyFolder()}/${month}`);
    await this.ensureFolder(folder);
    const path = normalizePath(`${folder}/restored-${createId("session")}.jsonl`);
    await this.app.vault.adapter.write(
      path,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }

  async writeBackup(backup: FullBackup, prefix = "backup"): Promise<string> {
    const fileName = `${prefix}-${safeTimestamp(new Date())}-${createId("export").slice(-8)}.json`;
    const path = normalizePath(`${this.exportsFolder()}/${fileName}`);
    await this.ensureFolder(this.exportsFolder());
    const payload = `${JSON.stringify(backup, null, 2)}\n`;
    await this.app.vault.adapter.write(path, payload);
    if (await this.app.vault.adapter.read(path) !== payload) throw new Error("备份校验失败。");
    return path;
  }

  async writeCsv(csv: string): Promise<string> {
    const path = normalizePath(`${this.exportsFolder()}/review-history-${safeTimestamp(new Date())}.csv`);
    await this.app.vault.adapter.write(path, csv);
    return path;
  }

  async listBackups(): Promise<string[]> {
    const files = await this.listFilesRecursively(this.exportsFolder());
    return files.filter((file) => file.endsWith(".json")).sort().reverse();
  }

  async readBackup(path: string): Promise<FullBackup> {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${this.exportsFolder()}/`)) {
      throw new Error("只能从复习中心导出目录恢复备份。");
    }
    return JSON.parse(await this.app.vault.adapter.read(normalized)) as FullBackup;
  }

  recordPath(reviewId: string): string {
    const shard = reviewId.replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase() || "xx";
    return normalizePath(`${this.recordsFolder()}/${shard}/${reviewId}.json`);
  }

  baseFolder(): string {
    return normalizePath(this.getSettings().dataFolder || "复习中心数据");
  }

  private recordsFolder(): string {
    return normalizePath(`${this.baseFolder()}/records`);
  }

  private historyFolder(): string {
    return normalizePath(`${this.baseFolder()}/history`);
  }

  private exportsFolder(): string {
    return normalizePath(`${this.baseFolder()}/exports`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private async listFilesRecursively(folder: string): Promise<string[]> {
    if (!(await this.app.vault.adapter.exists(folder))) return [];
    const result: string[] = [];
    const pending = [folder];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      const listing = await this.app.vault.adapter.list(current);
      result.push(...listing.files);
      pending.push(...listing.folders);
    }
    return result;
  }

  private async serializeWrite(path: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writeChains.set(path, next);
    try {
      await next;
    } finally {
      if (this.writeChains.get(path) === next) this.writeChains.delete(path);
    }
  }
}

function deduplicateEvents(events: HistoryEvent[]): HistoryEvent[] {
  const byId = new Map<string, HistoryEvent>();
  for (const event of events) byId.set(event.eventId, event);
  return [...byId.values()].sort(
    (left, right) =>
      new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime() ||
      left.eventId.localeCompare(right.eventId),
  );
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
