import type { Grade } from "ts-fsrs";
import { createHistoryEvent } from "./history";
import { buildDailyQueue, collectEntries, getQueueCounts } from "./queue";
import {
  applyRating,
  previewSchedule,
  resetSchedule,
} from "./scheduler";
import { VaultScanner } from "./scanner";
import { ReviewStore } from "./storage";
import type {
  FullBackup,
  HistoryAction,
  HistoryEvent,
  QueueCounts,
  QueueEntry,
  ReviewCenterSettings,
  ReviewItem,
  ReviewMode,
  ReviewSession,
  SourceRecord,
  UndoEntry,
} from "./types";
import { cloneValue, createId, itemKey } from "./utils";

export class ReviewService {
  records: SourceRecord[] = [];
  history: HistoryEvent[] = [];
  session: ReviewSession | null = null;
  conflicts = 0;
  private undoStack: UndoEntry[] = [];

  constructor(
    private readonly scanner: VaultScanner,
    private readonly store: ReviewStore,
    private readonly getSettings: () => ReviewCenterSettings,
    private readonly pluginVersion: string,
    private readonly onSessionChanged: (session: ReviewSession | null) => void,
  ) {}

  async refresh(): Promise<void> {
    const result = await this.scanner.scan();
    this.records = result.records;
    this.history = result.history;
    this.conflicts = result.conflicts;
    if (this.session) {
      this.session.entryKeys = this.session.entryKeys.filter((key) => this.findAnyEntry(key));
      if (this.session.currentIndex > this.session.entryKeys.length) {
        this.session.currentIndex = this.session.entryKeys.length;
      }
      this.persistSession();
    }
  }

  restoreLocalSession(session: ReviewSession | null): void {
    if (!session || session.entryKeys.length === 0) return;
    this.session = session;
  }

  counts(mode: ReviewMode): QueueCounts {
    return getQueueCounts(this.records, mode);
  }

  allCount(mode: ReviewMode): number {
    return collectEntries(this.records, mode).length;
  }

  nextDue(mode: ReviewMode): Date | null {
    const timestamps = collectEntries(this.records, mode)
      .filter((entry) => entry.item.schedule.reps > 0)
      .map((entry) => new Date(entry.item.schedule.due).getTime())
      .filter(Number.isFinite);
    return timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null;
  }

  currentPendingChange(): boolean {
    if (!this.session || this.session.currentIndex >= this.session.entryKeys.length) return false;
    const entry = this.findAnyEntry(this.session.entryKeys[this.session.currentIndex]);
    return entry?.item.status === "pending-change";
  }

  startSession(mode: ReviewMode, extra = false): QueueEntry | null {
    const queue = buildDailyQueue(
      this.records,
      this.history,
      this.getSettings(),
      mode,
      new Date(),
      extra,
    );
    this.session = {
      id: createId("session"),
      mode,
      entryKeys: queue.map((entry) => itemKey(entry.sourceId, entry.item.id)),
      currentIndex: 0,
      answerVisible: false,
      startedAt: new Date().toISOString(),
    };
    this.undoStack = [];
    this.persistSession();
    return this.currentEntry();
  }

  currentEntry(): QueueEntry | null {
    if (!this.session) return null;
    while (this.session.currentIndex < this.session.entryKeys.length) {
      const key = this.session.entryKeys[this.session.currentIndex];
      const entry = this.findEntry(key);
      if (entry) return entry;
      const pending = this.findAnyEntry(key);
      if (pending?.item.status === "pending-change") return null;
      this.session.currentIndex += 1;
    }
    this.persistSession();
    return null;
  }

  progress(): { current: number; total: number } {
    if (!this.session) return { current: 0, total: 0 };
    return {
      current: Math.min(this.session.currentIndex + 1, this.session.entryKeys.length),
      total: this.session.entryKeys.length,
    };
  }

  setAnswerVisible(visible: boolean): void {
    if (!this.session) return;
    this.session.answerVisible = visible;
    this.persistSession();
  }

  preview(entry: QueueEntry) {
    return previewSchedule(entry.item, this.retentionFor(entry.item.kind));
  }

  async gradeCurrent(rating: Grade): Promise<QueueEntry | null> {
    const entry = this.currentEntry();
    if (!entry || !this.session) return null;
    const record = this.recordById(entry.sourceId);
    if (!record) return null;
    const before = cloneValue(entry.item);
    const after = applyRating(entry.item, rating, this.retentionFor(entry.item.kind));
    this.replaceItem(record, after);
    const event = this.makeEvent(record.reviewId, after.id, "review", before.revision, after, rating);
    await this.persistMutation(record, event);
    this.undoStack.push({ sourceId: record.reviewId, itemId: after.id, before, after: cloneValue(after) });
    this.session.currentIndex += 1;
    this.session.answerVisible = false;
    this.appendNewlyDueEntries();
    this.persistSession();
    return this.currentEntry();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  async undoLast(): Promise<QueueEntry | null> {
    const undo = this.undoStack.pop();
    if (!undo || !this.session) return this.currentEntry();
    const record = this.recordById(undo.sourceId);
    const current = record ? this.itemFromRecord(record, undo.itemId) : undefined;
    if (!record || !current || current.revision !== undo.after.revision) return this.currentEntry();
    const restored: ReviewItem = {
      ...cloneValue(undo.before),
      revision: current.revision + 1,
    };
    this.replaceItem(record, restored);
    const event = this.makeEvent(record.reviewId, restored.id, "undo", current.revision, restored);
    await this.persistMutation(record, event);
    const key = itemKey(record.reviewId, restored.id);
    const targetIndex = Math.max(0, this.session.currentIndex - 1);
    this.session.entryKeys[targetIndex] = key;
    this.session.currentIndex = targetIndex;
    this.session.answerVisible = false;
    this.persistSession();
    return this.currentEntry();
  }

  finishSession(): void {
    this.session = null;
    this.undoStack = [];
    this.persistSession();
  }

  pendingChanges(sourceId?: string): Array<{ record: SourceRecord; item: ReviewItem }> {
    const result: Array<{ record: SourceRecord; item: ReviewItem }> = [];
    for (const record of this.records) {
      if (sourceId && record.reviewId !== sourceId) continue;
      for (const item of Object.values(record.cards)) {
        if (item.status === "pending-change") result.push({ record, item });
      }
    }
    return result;
  }

  async resolveChanges(
    choices: Array<{ sourceId: string; itemId: string; reset: boolean }>,
  ): Promise<void> {
    for (const choice of choices) {
      const record = this.recordById(choice.sourceId);
      const item = record ? this.itemFromRecord(record, choice.itemId) : undefined;
      if (!record || !item || item.status !== "pending-change") continue;
      const baseRevision = item.revision;
      const updated: ReviewItem = {
        ...(choice.reset ? resetSchedule(item) : { ...item, revision: item.revision + 1 }),
        acceptedHash: item.pendingHash ?? item.acceptedHash,
        pendingHash: undefined,
        status: "active",
      };
      this.replaceItem(record, updated);
      await this.persistMutation(
        record,
        this.makeEvent(
          record.reviewId,
          item.id,
          choice.reset ? "change-reset" : "change-keep",
          baseRevision,
          updated,
        ),
      );
    }
  }

  async setItemStatus(
    sourceId: string,
    itemId: string,
    action: "suspend" | "resume" | "remove" | "reset",
  ): Promise<void> {
    const record = this.recordById(sourceId);
    const item = record ? this.itemFromRecord(record, itemId) : undefined;
    if (!record || !item) return;
    const baseRevision = item.revision;
    let updated: ReviewItem;
    if (action === "reset") {
      updated = resetSchedule(item);
    } else {
      updated = {
        ...item,
        revision: item.revision + 1,
        status: action === "resume" ? "active" : action === "remove" ? "removed" : "suspended",
      };
    }
    this.replaceItem(record, updated);
    await this.persistMutation(record, this.makeEvent(sourceId, itemId, action, baseRevision, updated));
  }

  async createBackup(prefix = "backup"): Promise<string> {
    const backup: FullBackup = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      pluginVersion: this.pluginVersion,
      settings: cloneValue(this.getSettings()),
      records: cloneValue(this.records),
      history: cloneValue(this.history),
    };
    return this.store.writeBackup(backup, prefix);
  }

  async exportHistoryCsv(): Promise<string> {
    const recordMap = new Map(this.records.map((record) => [record.reviewId, record]));
    const rows = [
      [
        "occurred_at",
        "source_path",
        "source_title",
        "item_id",
        "item_kind",
        "rating",
        "rating_label",
        "next_due",
        "device_id",
      ],
    ];
    for (const event of this.history.filter((entry) => entry.action === "review")) {
      const record = recordMap.get(event.sourceId);
      rows.push([
        event.occurredAt,
        record?.sourcePath ?? "",
        record?.sourceTitle ?? "",
        event.itemId,
        event.after?.kind ?? "",
        String(event.rating ?? ""),
        CSV_GRADE_LABELS[event.rating ?? -1] ?? "",
        event.after?.schedule.due ?? "",
        event.deviceId,
      ]);
    }
    return this.store.writeCsv(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
  }

  async restoreBackup(path: string): Promise<ReviewCenterSettings> {
    const backup = await this.store.readBackup(path);
    validateBackup(backup);
    await this.createBackup("pre-restore");
    const importedIds = new Set(backup.records.map((record) => record.reviewId));
    for (const record of this.records) {
      if (!importedIds.has(record.reviewId)) await this.store.deleteRecord(record.reviewId);
    }
    for (const record of backup.records) await this.store.saveRecord(record);
    await this.store.replaceHistory(backup.history);
    this.records = cloneValue(backup.records);
    this.history = cloneValue(backup.history);
    this.finishSession();
    return {
      ...cloneValue(backup.settings),
      dataFolder: this.getSettings().dataFolder,
    };
  }

  private retentionFor(kind: ReviewItem["kind"]): number {
    return kind === "note" ? this.getSettings().noteRetention : this.getSettings().cardRetention;
  }

  private appendNewlyDueEntries(): void {
    if (!this.session) return;
    const queue = buildDailyQueue(
      this.records,
      this.history,
      this.getSettings(),
      this.session.mode,
    );
    const existing = new Set(this.session.entryKeys.slice(this.session.currentIndex));
    for (const entry of queue) {
      const key = itemKey(entry.sourceId, entry.item.id);
      if (!existing.has(key)) {
        this.session.entryKeys.push(key);
        existing.add(key);
      }
    }
  }

  private findEntry(key: string): QueueEntry | null {
    const entry = collectEntries(this.records, this.session?.mode ?? "card").find(
      (candidate) => itemKey(candidate.sourceId, candidate.item.id) === key,
    );
    return entry ?? null;
  }

  private findAnyEntry(key: string): QueueEntry | null {
    for (const record of this.records) {
      const items = this.session?.mode === "note" ? [record.note] : Object.values(record.cards);
      for (const item of items) {
        if (itemKey(record.reviewId, item.id) !== key) continue;
        return {
          sourceId: record.reviewId,
          sourcePath: record.sourcePath,
          sourceTitle: record.sourceTitle,
          tags: record.tags,
          item,
          isNew: item.schedule.reps === 0,
        };
      }
    }
    return null;
  }

  private recordById(sourceId: string): SourceRecord | undefined {
    return this.records.find((record) => record.reviewId === sourceId);
  }

  private itemFromRecord(record: SourceRecord, itemId: string): ReviewItem | undefined {
    return itemId === "note" ? record.note : record.cards[itemId];
  }

  private replaceItem(record: SourceRecord, item: ReviewItem): void {
    if (item.id === "note") record.note = item;
    else record.cards[item.id] = item;
    record.updatedAt = new Date().toISOString();
  }

  private async persistMutation(record: SourceRecord, event: HistoryEvent): Promise<void> {
    await this.store.appendHistory([event]);
    await this.store.saveRecord(record);
    this.history.push(event);
  }

  private makeEvent(
    sourceId: string,
    itemId: string,
    action: HistoryAction,
    baseRevision: number,
    after: ReviewItem | null,
    rating?: Grade,
  ): HistoryEvent {
    return createHistoryEvent({
      sessionId: this.store.sessionId,
      deviceId: this.store.deviceId,
      sourceId,
      itemId,
      action,
      baseRevision,
      after,
      rating,
    });
  }

  private persistSession(): void {
    this.onSessionChanged(this.session ? cloneValue(this.session) : null);
  }
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function validateBackup(value: FullBackup): void {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.history) ||
    !value.settings
  ) {
    throw new Error("备份格式或版本无效。");
  }
  for (const record of value.records) {
    if (record.schemaVersion !== 1 || !record.reviewId || !record.note) {
      throw new Error("备份中包含无效的来源记录。");
    }
  }
}

const CSV_GRADE_LABELS: Record<number, string> = {
  1: "重来",
  2: "困难",
  3: "良好",
  4: "简单",
};
