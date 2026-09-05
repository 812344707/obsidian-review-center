import type { Grade } from "ts-fsrs";
import { createHistoryEvent } from "./history";
import { buildDailyQueue, collectEntries, getQueueCounts, isLearning } from "./queue";
import {
  applyRating,
  previewSchedule,
  resetSchedule,
} from "./scheduler";
import { VaultScanner, type ScanResult } from "./scanner";
import type { ProgressReporter } from "./preparation";
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
  ReviewScope,
  SourceRecord,
  UndoEntry,
} from "./types";
import { cloneValue, createId, itemKey, localDayKey } from "./utils";
import { groupsFor, normalizeSettings, resolveGroup, tagsMatch } from "./config";
import { effectiveReviews } from "./activity";

export class ReviewService {
  records: SourceRecord[] = [];
  history: HistoryEvent[] = [];
  session: ReviewSession | null = null;
  conflicts = 0;
  private undoStack: UndoEntry[] = [];
  private gradePromise: Promise<QueueEntry | null> | null = null;
  hasLoaded = false;
  private operationTail: Promise<unknown> = Promise.resolve();
  maintenance = false;
  private prepared: { sessionId: string; key: string; signature: string; sourceHash: string } | null = null;

  private enqueue<T>(operation: () => Promise<T>, maintenance = false): Promise<T> {
    if (this.maintenance && !maintenance) return Promise.reject(new Error("正在迁移或批量处理，请稍候。"));
    const result = this.operationTail.catch(() => undefined).then(operation);
    this.operationTail = result.catch(() => undefined);
    return result;
  }

  async runMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    if (this.maintenance) throw new Error("已有批量操作正在进行，请稍候。");
    this.maintenance = true;
    try { return await this.enqueue(operation, true); }
    finally { this.maintenance = false; }
  }

  restoringSession = false;

  constructor(
    private readonly scanner: VaultScanner,
    private readonly store: ReviewStore,
    private readonly getSettings: () => ReviewCenterSettings,
    private readonly pluginVersion: string,
    private readonly onSessionChanged: (session: ReviewSession | null, undo: UndoEntry[]) => void,
  ) {}

  refresh(onProgress?: ProgressReporter): Promise<boolean> { return this.enqueue(() => this.performRefresh(onProgress)); }

  refreshSource(path: string): Promise<void> {
    return this.enqueue(async () => {
      const record = this.records.find((r) => r.sourcePath === path);
      if (!record) throw new Error("请先整理数据，将此笔记加入复习清单。");
      const result = await this.scanner.refreshSource(record);
      Object.assign(record, result.record);
      this.history = result.history;
    });
  }

  loadStored(): Promise<void> {
    return this.enqueue(async () => { this.applyScanResult(await this.scanner.loadStored()); });
  }

  sourceChanged(path: string): void { this.scanner.markSourceChanged(path); }
  sourceCreated(path: string): void { this.scanner.sourceCreated(path); }
  metadataReady(path: string, markdown: string): void { this.scanner.markMetadataReady(path, markdown); }
  sourceRenamed(oldPath: string, newPath: string): void { this.scanner.moveSource(oldPath, newPath); }

  private async performRefresh(onProgress?: ProgressReporter): Promise<boolean> {
    const result = await this.scanner.scan(onProgress);
    if (result.metadataReady === false) return false;
    this.applyScanResult(result);
    return true;
  }

  private applyScanResult(result: ScanResult): void {
    this.records = result.records;
    this.history = result.history;
    this.conflicts = result.conflicts;
    this.hasLoaded = result.metadataReady !== false;
    this.restoringSession = !!this.session && !this.hasLoaded;
    if (!this.hasLoaded) return;
    if (this.session) {
      const completed = this.session.entryKeys.slice(0, this.session.currentIndex);
      const remaining = this.session.entryKeys.slice(this.session.currentIndex).filter((key) => this.findAnyEntry(key));
      this.session.entryKeys = [...completed, ...remaining];
      this.persistSession();
    }
  }

  prepareCurrent(): Promise<QueueEntry | null> { return this.enqueue(() => this.performPrepareCurrent()); }

  private async verifyKey(key: string): Promise<string> {
    const [sourceId, itemId] = key.split("::");
    const record = this.recordById(sourceId);
    if (!record) return "";
    const result = await this.scanner.verifyEntry(record, itemId);
    if (result.record) Object.assign(record, result.record);
    else record.sourceStatus = "deleted";
    this.history = result.history;
    return result.sourceHash;
  }

  private async performPrepareCurrent(): Promise<QueueEntry | null> {
    this.prepared = null;
    while (this.session && !this.restoringSession && this.session.currentIndex < this.session.entryKeys.length) {
      const key = this.session.entryKeys[this.session.currentIndex];
      const sourceHash = await this.verifyKey(key);
      const entry = this.currentEntry();
      if (this.currentPendingChange()) return null;
      if (!entry) return null;
      if (itemKey(entry.sourceId, entry.item.id) !== key) continue;
      this.prepared = { sessionId: this.session.id, key, sourceHash, signature: entrySignature(entry) };
      return entry;
    }
    return null;
  }

  restoreLocalSession(session: ReviewSession | null, undo: UndoEntry[] = []): void {
    if (!session || session.entryKeys.length === 0) return;
    this.session = session;
    this.undoStack = cloneValue(undo);
    delete this.session.currentStartedAt;
    this.restoringSession = !this.hasLoaded;
  }

  counts(mode: ReviewMode, groupId?: string, tagPath?: string): QueueCounts {
    return getQueueCounts(this.records, this.history, this.getSettings(), mode, new Date(), groupId, tagPath);
  }

  allCount(mode: ReviewMode, groupId?: string): number {
    return collectEntries(this.records, mode, this.getSettings(), groupId).length;
  }

  nextDue(mode: ReviewMode, groupId?: string, tagPath?: string): Date | null {
    const timestamps = collectEntries(this.records, mode, this.getSettings(), groupId, tagPath)
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

  startOrResumeSession(mode: ReviewMode, extra = false, groupId?: string, tagPath?: string): QueueEntry | null {
    if (this.restoringSession) return null;
    const previous = this.session;
    if (previous && previous.mode === mode && (previous.extra ?? false) === extra &&
      previous.groupId === groupId && (previous.tagPath ?? "") === (tagPath ?? "")) {
      this.requeueDue();
      const entry = this.currentEntry();
      if (entry || this.currentPendingChange()) {
        this.setTimingActive(true);
        return entry;
      }
    }
    return this.startSession(mode, extra, groupId, tagPath);
  }

  startSession(mode: ReviewMode, extra = false, groupId?: string, tagPath?: string): QueueEntry | null {
    const queue = buildDailyQueue(
      this.records,
      this.history,
      this.getSettings(),
      mode,
      new Date(),
      extra,
      groupId,
      tagPath,
    );
    this.session = {
      id: createId("session"),
      mode,
      groupId,
      tagPath,
      extra,
      entryKeys: queue.map((entry) => itemKey(entry.sourceId, entry.item.id)),
      currentIndex: 0,
      answerVisible: false,
      startedAt: new Date().toISOString(),
      currentStartedAt: new Date().toISOString(),
      orderSeed: localDayKey(new Date()),
    };
    this.undoStack = [];
    this.persistSession();
    return this.currentEntry();
  }

  currentEntry(): QueueEntry | null {
    if (!this.session || this.restoringSession) return null;
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

  setTimingActive(active: boolean): void {
    if (!this.session) return;
    if (!active && this.session.currentStartedAt) {
      this.session.currentElapsedMs = Math.min(300000, (this.session.currentElapsedMs ?? 0) + Math.max(0, Date.now() - new Date(this.session.currentStartedAt).getTime()));
      delete this.session.currentStartedAt;
    } else if (active && !this.session.currentStartedAt) this.session.currentStartedAt = new Date().toISOString();
    this.persistSession();
  }

  preview(entry: QueueEntry) {
    return previewSchedule(entry.item, entry.group.parameters);
  }

  gradeCurrent(rating: Grade): Promise<QueueEntry | null> {
    if (this.gradePromise) return this.gradePromise;
    const key = this.session?.entryKeys[this.session.currentIndex];
    const displayed = key ? this.findAnyEntry(key) : null;
    const expected = this.prepared ?? (displayed && this.session ? {
      key: key!, sessionId: this.session.id, signature: entrySignature(displayed), sourceHash: "",
    } : null);
    this.gradePromise = this.enqueue(() => this.performGrade(rating, expected)).finally(() => { this.gradePromise = null; });
    return this.gradePromise;
  }

  private async performGrade(rating: Grade, expected: ReviewService["prepared"]): Promise<QueueEntry | null> {
    if (!expected || !this.session) return null;
    if (this.session.id !== expected.sessionId || this.session.entryKeys[this.session.currentIndex] !== expected.key) {
      throw new Error("当前条目已切换，请核对后重新评分。");
    }
    const sourceHash = await this.verifyKey(expected.key);
    const entry = this.currentEntry();
    if (!entry || itemKey(entry.sourceId, entry.item.id) !== expected.key ||
      entrySignature(entry) !== expected.signature ||
      (entry.item.kind === "note" && expected.sourceHash && expected.sourceHash !== sourceHash)) {
      this.prepared = null;
      throw new Error("当前内容或复习进度已变化，本次未评分，请核对更新后的内容。");
    }
    const record = this.recordById(entry.sourceId);
    if (!record) return null;
    const before = cloneValue(entry.item);
    const after = applyRating(entry.item, rating, entry.group.parameters);
    const p = entry.group.parameters;
    if (rating === 1 && after.schedule.lapses >= (p.leechThreshold ?? 8)) {
      after.leech = true;
      if (p.leechAction === "suspend") after.status = "suspended";
    }
    this.replaceItem(record, after);
    const event = this.makeEvent(record.reviewId, after.id, "review", before.revision, after, rating);
    event.mode = this.session.mode;
    event.groupId = entry.group.id;
    event.wasNew = entry.isNew;
    event.beforeSchedule = cloneValue(before.schedule);
    event.tagPath = entry.tagPath; event.presetId = entry.presetId; event.sourceTags = [...record.tags];
    event.durationMs = Math.min(300000, (this.session.currentElapsedMs ?? 0) + (this.session.currentStartedAt ? Math.max(0, Date.now() - new Date(this.session.currentStartedAt).getTime()) : 0));
    await this.persistMutation(record, event);
    const siblings: NonNullable<UndoEntry["siblings"]> = [];
    if (entry.item.kind === "cloze" && entry.item.blockId) {
      const now = new Date(), tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      for (const item of Object.values(record.cards)) {
        if (item.id === after.id || item.kind !== "cloze" || item.blockId !== after.blockId || item.status !== "active") continue;
        const candidate = { ...entry, item, isNew: item.schedule.reps === 0 };
        const interday = isLearning(candidate) && localDayKey(new Date(item.schedule.due)) > localDayKey(new Date(item.schedule.last_review ?? 0));
        if (!(candidate.isNew ? p.buryNew : interday ? p.buryInterday : !isLearning(candidate) && p.buryReview)) continue;
        const original = cloneValue(item), buried = { ...item, revision: item.revision + 1, buriedUntil: localDayKey(tomorrow), buriedBy: event.eventId };
        const buryEvent = this.makeEvent(record.reviewId, item.id, "bury", item.revision, buried);
        this.replaceItem(record, buried); await this.persistMutation(record, buryEvent);
        siblings.push({ before: original, after: cloneValue(buried), eventId: buryEvent.eventId });
      }
    }
    this.undoStack = [{ eventId: event.eventId, sourceId: record.reviewId, itemId: after.id, before, after: cloneValue(after), siblings }];
    this.session.currentIndex += 1;
    this.prepared = null;
    this.session.answerVisible = false;
    this.session.currentStartedAt = new Date().toISOString();
    this.session.currentElapsedMs = 0;
    this.appendNewlyDueEntries();
    this.persistSession();
    return this.currentEntry();
  }

  canUndo(): boolean {
    const undo = this.undoStack.at(-1);
    if (!undo || !this.session || this.restoringSession) return false;
    const current = this.recordById(undo.sourceId);
    return !!current && this.itemFromRecord(current, undo.itemId)?.revision === undo.after.revision;
  }

  undoLast(): Promise<QueueEntry | null> { return this.enqueue(() => this.performUndo()); }

  private async performUndo(): Promise<QueueEntry | null> {
    const last = this.undoStack.at(-1);
    if (last) await this.verifyKey(itemKey(last.sourceId, last.itemId));
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
    event.undoOf = undo.eventId;
    event.mode = this.session.mode;
    await this.persistMutation(record, event);
    for (const sibling of undo.siblings ?? []) {
      const item = record.cards[sibling.after.id];
      if (!item || item.revision !== sibling.after.revision || item.buriedBy !== undo.eventId) continue;
      const unburied = { ...cloneValue(sibling.before), revision: item.revision + 1 };
      this.replaceItem(record, unburied);
      await this.persistMutation(record, this.makeEvent(record.reviewId, item.id, "unbury", item.revision, unburied));
    }
    const key = itemKey(record.reviewId, restored.id);
    const targetIndex = Math.max(0, this.session.currentIndex - 1);
    this.session.entryKeys[targetIndex] = key;
    this.session.currentIndex = targetIndex;
    this.session.answerVisible = false;
    this.prepared = null;
    this.session.currentStartedAt = new Date().toISOString();
    this.session.currentElapsedMs = 0;
    this.persistSession();
    return this.currentEntry();
  }

  finishSession(): void {
    this.session = null;
    this.restoringSession = false;
    this.undoStack = [];
    this.persistSession();
  }

  pendingChanges(sourceId?: string): Array<{ record: SourceRecord; item: ReviewItem }> {
    const result: Array<{ record: SourceRecord; item: ReviewItem }> = [];
    for (const record of this.records) {
      if (sourceId && record.reviewId !== sourceId) continue;
      if (record.sourceStatus === "out-of-scope" || !resolveGroup(record.tags, this.getSettings().cardGroups, record.sourcePath)) continue;
      for (const item of Object.values(record.cards)) {
        if (item.status === "pending-change") result.push({ record, item });
      }
    }
    return result;
  }

  resolveChanges(choices: Array<{ sourceId: string; itemId: string; reset: boolean }>): Promise<void> {
    return this.enqueue(() => this.performResolveChanges(choices));
  }

  private async performResolveChanges(
    choices: Array<{ sourceId: string; itemId: string; reset: boolean }>,
  ): Promise<void> {
    for (const choice of choices) {
      const shown = this.recordById(choice.sourceId)?.cards[choice.itemId];
      if (!shown || shown.status !== "pending-change") continue;
      const expectedHash = shown.pendingHash, expectedRevision = shown.revision;
      await this.verifyKey(itemKey(choice.sourceId, choice.itemId));
      const record = this.recordById(choice.sourceId);
      const item = record ? this.itemFromRecord(record, choice.itemId) : undefined;
      if (!record || !item || item.status !== "pending-change") continue;
      if (item.pendingHash !== expectedHash || item.revision !== expectedRevision) {
        throw new Error("内容或同步进度又有变化，请重新核对后处理。");
      }
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

  setItemStatus(sourceId: string, itemId: string, action: "suspend" | "resume" | "remove" | "reset"): Promise<void> {
    return this.enqueue(() => this.performSetItemStatus(sourceId, itemId, action));
  }

  private async performSetItemStatus(
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

  createBackup(prefix = "backup"): Promise<string> { return this.enqueue(() => this.performCreateBackup(prefix)); }

  private async performCreateBackup(prefix: string): Promise<string> {
    const backup: FullBackup = {
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      pluginVersion: this.pluginVersion,
      settings: cloneValue(this.getSettings()),
      records: cloneValue(this.records),
      history: cloneValue(this.history),
    };
    return this.store.writeBackup(backup, prefix);
  }

  exportHistoryCsv(): Promise<string> { return this.enqueue(() => this.performExportHistoryCsv()); }

  private async performExportHistoryCsv(): Promise<string> {
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
        "group_id",
        "was_new",
      ],
    ];
    for (const event of effectiveReviews(this.history)) {
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
        event.groupId ?? "",
        event.wasNew === undefined ? "" : String(event.wasNew),
      ]);
    }
    return this.store.writeCsv(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
  }

  restoreBackup(path: string): Promise<ReviewCenterSettings> { return this.enqueue(() => this.performRestoreBackup(path)); }

  private async performRestoreBackup(path: string): Promise<ReviewCenterSettings> {
    this.restoreConflicts = [];
    const backup = await this.store.readBackup(path);
    validateBackup(backup);
    await this.performCreateBackup("pre-restore");
    if (backup.kind === "scope") return this.mergeScopeBackup(backup);
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
      ...normalizeSettings(backup.settings),
      dataFolder: this.getSettings().dataFolder,
    };
  }

  restoreConflicts: string[] = [];
  exportScope(scope: ReviewScope): Promise<string> {
    return this.enqueue(async () => {
      const records = this.records.filter((r) => resolveGroup(r.tags, groupsFor(this.getSettings(), scope.mode), r.sourcePath)?.id === scope.groupId && tagsMatch(r.tags, scope.tagPath));
      const keys = records.flatMap((r) => (scope.mode === "note" ? [r.note] : Object.values(r.cards)).map((i) => itemKey(r.reviewId, i.id)));
      const wanted = new Set(keys);
      const settings = cloneValue(this.getSettings());
      settings.noteGroups = scope.mode === "note" ? settings.noteGroups.filter((g) => g.id === scope.groupId) : [];
      settings.cardGroups = scope.mode === "card" ? settings.cardGroups.filter((g) => g.id === scope.groupId) : [];
      const group = groupsFor(settings, scope.mode)[0];
      const presets = new Set([group?.presetId, ...Object.values(group?.nodes ?? {}).map((n) => n.presetId)]);
      settings.presets = settings.presets?.filter((p) => p.mode === scope.mode && presets.has(p.id));
      const exported = cloneValue(records);
      for (const record of exported) {
        if (scope.mode === "note") { record.cards = {}; record.tombstones = {}; }
        else { record.note = { ...resetSchedule(record.note), status: "removed" }; delete record.note.lastReviewedAt; }
      }
      return this.store.writeBackup({ schemaVersion: 4, kind: "scope", scope, itemKeys: keys,
        exportedAt: new Date().toISOString(), pluginVersion: this.pluginVersion,
        settings, records: exported,
        history: cloneValue(this.history.filter((e) => wanted.has(itemKey(e.sourceId, e.itemId)))),
      }, "scope");
    });
  }
  private async mergeScopeBackup(backup: FullBackup): Promise<ReviewCenterSettings> {
    if (!backup.scope || !Array.isArray(backup.itemKeys)) throw new Error("范围备份缺少范围信息。");
    const importedKeys = new Set(backup.itemKeys), accepted = new Set<string>(); this.restoreConflicts = [];
    for (const incoming of backup.records) {
      let local = this.recordById(incoming.reviewId);
      if (!local) {
        local = cloneValue(incoming);
        if (!importedKeys.has(itemKey(local.reviewId, "note"))) local.note = { ...resetSchedule(local.note), status: "removed" };
        local.cards = Object.fromEntries(Object.entries(local.cards).filter(([id]) => importedKeys.has(itemKey(local!.reviewId, id))));
        this.records.push(local);
        for (const key of importedKeys) if (key.startsWith(local.reviewId + "::")) accepted.add(key);
      } else {
        for (const item of [incoming.note, ...Object.values(incoming.cards)]) {
          const key = itemKey(incoming.reviewId, item.id); if (!importedKeys.has(key)) continue;
          const existing = this.itemFromRecord(local, item.id);
          if (existing) { if (JSON.stringify(existing) !== JSON.stringify(item)) this.restoreConflicts.push(incoming.sourcePath + " · " + item.id); else accepted.add(key); continue; }
          this.replaceItem(local, cloneValue(item)); accepted.add(key);
        }
      }
      await this.store.saveRecord(local);
    }
    const additions = backup.history.filter((e) => accepted.has(itemKey(e.sourceId, e.itemId)) && !this.history.some((old) => old.eventId === e.eventId));
    await this.store.appendHistory(additions); this.history.push(...additions);
    const settings = cloneValue(this.getSettings()), imported = normalizeSettings(backup.settings);
    const mode = backup.scope.mode, group = groupsFor(imported, mode).find((g) => g.id === backup.scope!.groupId);
    const localGroup = group && groupsFor(normalizeSettings(settings), mode).find((g) => g.id === group.id);
    if (group && localGroup && JSON.stringify(localGroup) !== JSON.stringify(group)) this.restoreConflicts.push("复习组设置：" + group.name);
    if (group && !groupsFor(settings, mode).some((g) => g.id === group.id)) {
      groupsFor(settings, mode).push(group);
      for (const p of imported.presets ?? []) {
        const old = settings.presets?.find((old) => old.id === p.id);
        if (!old) (settings.presets ??= []).push(p);
        else if (JSON.stringify(old) !== JSON.stringify(p)) this.restoreConflicts.push("参数预设：" + p.name);
      }
    }
    return settings;
  }

  requeueDue(): boolean {
    if (!this.session || this.restoringSession) return false;
    const before = this.session.entryKeys.length;
    this.appendNewlyDueEntries();
    if (before !== this.session.entryKeys.length) this.persistSession();
    return before !== this.session.entryKeys.length;
  }

  private appendNewlyDueEntries(): void {
    if (!this.session) return;
    const queue = buildDailyQueue(
      this.records,
      this.history,
      this.getSettings(),
      this.session.mode,
      new Date(),
      false,
      this.session.groupId,
      this.session.tagPath,
      this.session.orderSeed,
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
    const entry = buildDailyQueue(this.records, this.history, this.getSettings(), this.session?.mode ?? "card",
      new Date(), this.session?.extra ?? false, this.session?.groupId, this.session?.tagPath, this.session?.orderSeed).find(
      (candidate) => itemKey(candidate.sourceId, candidate.item.id) === key,
    );
    return entry ?? null;
  }

  private findAnyEntry(key: string): QueueEntry | null {
    for (const record of this.records) {
      const group = resolveGroup(record.tags, groupsFor(this.getSettings(), this.session?.mode ?? "card"), record.sourcePath);
      if (!tagsMatch(record.tags, this.session?.tagPath) || !group || (this.session?.groupId && group.id !== this.session.groupId) || record.sourceStatus === "out-of-scope" || record.sourceStatus === "deleted") continue;
      const items = this.session?.mode === "note" ? [record.note] : Object.values(record.cards);
      for (const item of items) {
        if (itemKey(record.reviewId, item.id) !== key) continue;
        return {
          group,
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
    this.onSessionChanged(this.session ? cloneValue(this.session) : null, cloneValue(this.undoStack));
  }
}

function entrySignature(entry: QueueEntry): string {
  return JSON.stringify([entry.sourceTitle, entry.item, entry.group.id, entry.group.parameters]);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function validateBackup(value: FullBackup): void {
  if (
    ![1, 2, 3, 4].includes(value.schemaVersion) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.history) ||
    !value.settings
  ) {
    throw new Error("备份格式或版本无效。");
  }
  for (const record of value.records) {
    if (record.schemaVersion !== 1 || !record.reviewId || !/^[a-z0-9_-]+$/i.test(record.reviewId) || !record.note) {
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
