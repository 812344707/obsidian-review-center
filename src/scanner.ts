import { App, TFile, getAllTags } from "obsidian";
import { createHistoryEvent, reconcileRecordsWithHistory } from "./history";
import { convertLegacySection, insertMissingBlockIds, parseReviewCallouts } from "./parser";
import { createSchedule } from "./scheduler";
import { ReviewStore } from "./storage";
import type {
  HistoryEvent,
  ParsedCardDraft,
  ReviewCenterSettings,
  ReviewItem,
  SourceRecord,
} from "./types";
import { createId, pathIsInside, hashText } from "./utils";
import { resolveGroup } from "./config";
import { PreparationTracker, type ProgressReporter } from "./preparation";
import { verifySource, type VerifiedSource } from "./source-verifier";

interface IdentifiedFile {
  file: TFile;
  reviewId: string;
}

export interface ScanResult {
  records: SourceRecord[];
  history: HistoryEvent[];
  conflicts: number;
  metadataReady?: boolean;
}

export class VaultScanner {
  private knownRevisions = new Map<string, number>();
  private pendingMetadata = new Set<string>();
  private indexedHashes = new Map<string, string>();
  private verifiedHashes = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly store: ReviewStore,
    private readonly getSettings: () => ReviewCenterSettings,
  ) {}

  markSourceChanged(path: string): void { this.pendingMetadata.add(path); }

  sourceCreated(path: string): void {
    // Vault startup emits create for files whose persisted metadata is already loaded.
    this.pendingMetadata.delete(path);
    this.indexedHashes.delete(path);
    this.verifiedHashes.delete(path);
  }

  markMetadataReady(path: string, markdown: string): void {
    this.pendingMetadata.delete(path);
    this.indexedHashes.set(path, hashText(markdown));
  }

  moveSource(oldPath: string, newPath: string): void {
    // Obsidian does not emit metadata "changed" for a pure rename.
    const matches = (path: string) => path === oldPath || path.startsWith(oldPath + "/");
    for (const hashes of [this.indexedHashes, this.verifiedHashes]) {
      for (const [path, hash] of [...hashes]) {
        if (!matches(path)) continue;
        hashes.delete(path);
        hashes.set(newPath + path.slice(oldPath.length), hash);
      }
    }
    for (const path of [...this.pendingMetadata]) {
      if (!matches(path)) continue;
      this.pendingMetadata.delete(path);
      this.pendingMetadata.add(newPath + path.slice(oldPath.length));
    }
  }

  async verifyEntry(record: SourceRecord, itemId: string): Promise<VerifiedSource> {
    const result = await verifySource(this.app, this.store, this.getSettings(), record, itemId, (path, markdown) => {
      const indexed = this.indexedHashes.get(path);
      if (indexed === hashText(markdown) || this.verifiedHashes.get(path) === hashText(markdown)) {
        this.pendingMetadata.delete(path); return;
      }
      if (this.pendingMetadata.has(path) || (indexed && indexed !== hashText(markdown))) {
        throw new Error("当前笔记正在保存或更新索引，请稍后重试。");
      }
    });
    if (result.record && result.sourceHash) this.verifiedHashes.set(result.record.sourcePath, result.sourceHash);
    return result;
  }

  async loadStored(onProgress?: ProgressReporter): Promise<ScanResult> {
    const progress = new PreparationTracker(onProgress);
    await this.store.initialize();
    const history = await this.store.loadAllHistory((done, total) => progress.step(0, 10, done, total, "读取评分历史"));
    const loaded = await this.store.loadAllRecords((done, total) => progress.step(10, 20, done, total, "读取复习清单"));
    const reconciled = reconcileRecordsWithHistory(loaded, history);
    return { ...reconciled, history };
  }

  async refreshSource(source: SourceRecord): Promise<{ record: SourceRecord; history: HistoryEvent[] }> {
    const verified = await this.verifyEntry(source, "note");
    const record = verified.record;
    if (!record || record.sourceStatus === "deleted") throw new Error("当前笔记已删除，无法更新卡片。");
    const file = this.app.vault.getAbstractFileByPath(record.sourcePath);
    if (!(file instanceof TFile)) throw new Error("笔记路径已变化，请重新打开。");
    const settings = this.getSettings();
    if (!resolveGroup(record.tags, settings.cardGroups, file.path)) throw new Error("此笔记未在卡片识别范围内，请在“卡片识别”中设置文件夹或标签条件。");
    this.knownRevisions = collectLatestRevisions(verified.history);
    const events: HistoryEvent[] = [];
    const updated = await this.scanFile({ file, reviewId: record.reviewId }, record, events);
    await this.store.appendHistory(events);
    await this.store.saveRecord(updated);
    return { record: updated, history: [...verified.history, ...events] };
  }

  async scan(onProgress?: ProgressReporter): Promise<ScanResult> {
    const progress = new PreparationTracker(onProgress);
    await this.store.initialize();
    const history = await this.store.loadAllHistory((done, total) => progress.step(0, 10, done, total, "读取评分历史"));
    this.knownRevisions = collectLatestRevisions(history);
    const loaded = await this.store.loadAllRecords((done, total) => progress.step(10, 20, done, total, "读取复习清单"));
    const snapshots = new Map(loaded.map((record) => [record.reviewId, {
      signature: recordSignature(record), updatedAt: record.updatedAt,
    }]));
    const reconciled = reconcileRecordsWithHistory(loaded, history);
    const recordById = new Map(reconciled.records.map((record) => [record.reviewId, record]));
    const recordByPath = new Map(reconciled.records.map((record) => [record.sourcePath, record]));
    const settings = this.getSettings();
    const allMarkdown = this.app.vault.getMarkdownFiles();
    const fileByPath = new Map(allMarkdown.map((file) => [file.path, file]));
    await progress.step(20, 20, 1, 1, "检查笔记和标签");
    // Metadata may lag behind vault events at startup or after a rename. Never
    // infer deletion or mint identities until every Markdown cache is available.
    if (allMarkdown.some((file) => !this.app.metadataCache.getFileCache(file))) {
      return { records: reconciled.records, history, conflicts: reconciled.conflicts, metadataReady: false };
    }
    const outsideIdentityPaths = this.collectKnownIdentityPaths(allMarkdown, recordById);
    const watchedFiles = allMarkdown.filter((file) => {
      if (pathIsInside(file.path, settings.dataFolder)) return false;
      const tags = getAllTags(this.app.metadataCache.getFileCache(file)!) ?? [];
      return resolveGroup(tags, settings.noteGroups, file.path) || resolveGroup(tags, settings.cardGroups, file.path);
    });
    const migrationWarnings = new Map<string, string[]>();
    const blockedIdentityPaths = new Set<string>();
    const identityPaths = new Map<string, string[]>();
    for (const file of allMarkdown) {
      if (pathIsInside(file.path, settings.dataFolder)) continue;
      const id = readReviewId(this.app.metadataCache.getFileCache(file)?.frontmatter);
      if (id) identityPaths.set(id, [...(identityPaths.get(id) ?? []), file.path]);
    }
    let backedUp = false;
    let checked = 0;
    for (const file of allMarkdown) {
      await progress.step(20, 45, ++checked, allMarkdown.length, `检查材料 ${checked}/${allMarkdown.length}`);
      if (pathIsInside(file.path, settings.dataFolder)) continue;
      const known = recordById.get(readReviewId(this.app.metadataCache.getFileCache(file)?.frontmatter) ?? "") ??
        recordByPath.get(file.path);
      const tags = getAllTags(this.app.metadataCache.getFileCache(file)!) ?? [];
      if (!known && !resolveGroup(tags, settings.cardGroups, file.path)) continue;
      try {
        const original = await this.app.vault.read(file);
        const conversion = convertLegacySection(original, settings.reviewHeading, settings.reviewHeadingLevel, settings.reviewCalloutTypes);
        if (conversion.warnings.length) { migrationWarnings.set(file.path, conversion.warnings); continue; }
        if (!conversion.changed) continue;
        const duplicates = known ? identityPaths.get(known.reviewId) ?? [] : [];
        if (duplicates.length > 1) {
          const warning = "旧章节迁移遇到重复的笔记标识，原文和进度保留，请先核对这些笔记：" + duplicates.join("、");
          for (const path of duplicates) { blockedIdentityPaths.add(path); migrationWarnings.set(path, [warning]); }
          continue;
        }
        if (known) {
          const converted = parseReviewCallouts(conversion.markdown, settings.reviewCalloutTypes);
          const byId = new Map(converted.cards.filter((card) => card.blockId).map((card) =>
            [card.blockId + (card.kind === "qa" ? ":qa" : ":c" + card.clozeIndex), card]));
          if (Object.values(known.cards).some((card) => card.status !== "removed" &&
            (!byId.has(card.id) || ![card.acceptedHash, card.pendingHash].includes(byId.get(card.id)!.hash)))) {
            migrationWarnings.set(file.path, ["旧章节与已有卡片的标识或内容无法对应，已保留原文和进度。请根据备份核对，或手动改为复习块后重新扫描。"]);
            continue;
          }
        }
        if (!backedUp) {
          await this.store.writeBackup({
            schemaVersion: 3, exportedAt: new Date().toISOString(), pluginVersion: "0.3.0",
            settings, records: reconciled.records, history,
          }, "pre-callout-migration");
          backedUp = true;
        }
        await this.store.backupSource(file.path, original, known);
        await this.app.vault.process(file, (current) => {
          if (current !== original) throw new Error("迁移期间笔记发生修改，已跳过，请重新扫描。");
          return conversion.markdown;
        });
      } catch (error) {
        migrationWarnings.set(file.path, ["复习块迁移未完成，原有进度保留：" + (error instanceof Error ? error.message : String(error))]);
      }
    }
    const identified = await this.identifyWatchedFiles(watchedFiles.filter((file) => !blockedIdentityPaths.has(file.path)), recordById, outsideIdentityPaths,
      (done, total) => progress.step(45, 55, done, total, `核对笔记标识 ${done}/${total}`));
    const activeIds = new Set<string>();
    const resultRecords: SourceRecord[] = [];

    let organized = 0;
    for (const entry of identified) {
      const fileEvents: HistoryEvent[] = [];
      const record = await this.scanFile(entry, recordById.get(entry.reviewId), fileEvents, migrationWarnings.get(entry.file.path));
      activeIds.add(record.reviewId);
      resultRecords.push(record);
      await this.store.appendHistory(fileEvents);
      history.push(...fileEvents);
      await this.saveChangedRecord(record, snapshots);
      await progress.step(55, 95, ++organized, identified.length, `整理材料 ${organized}/${identified.length}`);
    }

    let reconciledCount = 0;
    for (const record of reconciled.records) {
      await progress.step(95, 99, ++reconciledCount, reconciled.records.length, "核对移出和删除的材料");
      if (activeIds.has(record.reviewId)) continue;
      const outsidePath = outsideIdentityPaths.get(record.reviewId) ??
        (fileByPath.has(record.sourcePath) ? record.sourcePath : undefined);
      if (outsidePath) {
        record.sourcePath = outsidePath;
        record.sourceTitle = outsidePath.split("/").at(-1)?.replace(/\.md$/i, "") ?? outsidePath;
        const file = fileByPath.get(outsidePath);
        const cache = file && this.app.metadataCache.getFileCache(file);
        record.tags = cache ? (getAllTags(cache) ?? []) : record.tags;
        record.sourceStatus = blockedIdentityPaths.has(outsidePath) ? "parse-error" : "out-of-scope";
        if (migrationWarnings.has(outsidePath)) record.warnings = migrationWarnings.get(outsidePath)!;
        record.updatedAt = new Date().toISOString();
        resultRecords.push(record);
        await this.saveChangedRecord(record, snapshots);
      } else {
        const deleteEvents = this.deleteRecordItems(record);
        await this.store.appendHistory(deleteEvents);
        history.push(...deleteEvents);
        await this.store.deleteRecord(record.reviewId);
      }
    }
    await progress.step(99, 99, 1, 1, "保存复习清单");

    return {
      records: resultRecords,
      history,
      conflicts: reconciled.conflicts,
    };
  }

  private async saveChangedRecord(record: SourceRecord, snapshots: Map<string, { signature: string; updatedAt: string }>): Promise<void> {
    const previous = snapshots.get(record.reviewId);
    if (previous?.signature === recordSignature(record)) {
      record.updatedAt = previous.updatedAt;
      return;
    }
    await this.store.saveRecord(record);
  }

  private async identifyWatchedFiles(
    files: TFile[],
    records: Map<string, SourceRecord>,
    owners: Map<string, string>,
    onProgress?: (done: number, total: number) => Promise<void>,
  ): Promise<IdentifiedFile[]> {
    const entries: IdentifiedFile[] = [];
    for (const file of files) {
      let reviewId = await this.ensureReviewId(file);
      const owner = owners.get(reviewId);
      if (owner && owner !== file.path) {
        reviewId = createId("note");
        await this.setReviewId(file, reviewId);
      }
      entries.push({ file, reviewId });
      await onProgress?.(entries.length, files.length);
    }

    const byId = new Map<string, IdentifiedFile[]>();
    for (const entry of entries) {
      const group = byId.get(entry.reviewId) ?? [];
      group.push(entry);
      byId.set(entry.reviewId, group);
    }
    for (const [reviewId, group] of byId) {
      if (group.length < 2) continue;
      const knownOwnerPath = records.get(reviewId)?.sourcePath;
      const owner = group.find((entry) => entry.file.path === knownOwnerPath) ??
        [...group].sort((left, right) => left.file.path.localeCompare(right.file.path))[0];
      for (const duplicate of group) {
        if (duplicate === owner) continue;
        duplicate.reviewId = createId("note");
        await this.setReviewId(duplicate.file, duplicate.reviewId);
      }
    }
    return entries.sort((left, right) => left.file.path.localeCompare(right.file.path, "zh-CN"));
  }

  private async scanFile(
    entry: IdentifiedFile,
    existing: SourceRecord | undefined,
    events: HistoryEvent[],
    migrationWarnings?: string[],
  ): Promise<SourceRecord> {
    const settings = this.getSettings();
    const now = new Date();
    const cache = this.app.metadataCache.getFileCache(entry.file);
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    const cardGroup = resolveGroup(tags, settings.cardGroups, entry.file.path);
    let parsed: ReturnType<typeof parseReviewCallouts> | undefined;
    let scannedMarkdown = "";
    if (migrationWarnings?.length) {
      parsed = { found: true, valid: false, cards: [], warnings: migrationWarnings };
    } else if (cardGroup) {
      let markdown = await this.app.vault.read(entry.file);
      parsed = parseReviewCallouts(markdown, settings.reviewCalloutTypes);
      if (parsed.valid && parsed.cards.some((draft) => !draft.blockId)) {
        await this.app.vault.process(entry.file, (current) => {
          const latest = parseReviewCallouts(current, settings.reviewCalloutTypes);
          return latest.valid ? insertMissingBlockIds(current, latest.cards, () => createId("rv")) : current;
        });
        markdown = await this.app.vault.read(entry.file);
        parsed = parseReviewCallouts(markdown, settings.reviewCalloutTypes);
      }
      scannedMarkdown = markdown;
    }
    if (parsed?.valid && existing && scannedMarkdown) {
      const recognized = new Set(parsed.cards.map((card) => card.blockId));
      const stillPresent = new Set([...scannedMarkdown.matchAll(/^[ \t]*(?:>[ \t]*)*\^(rv-[a-z0-9-]+)[ \t]*$/gmi)].map((match) => match[1].toLowerCase()));
      if (Object.values(existing.cards).some((card) => card.blockId && !recognized.has(card.blockId) && stillPresent.has(card.blockId))) {
        parsed.valid = false;
        parsed.warnings.push("原卡片标识仍在笔记中，但不在可识别的复习块内；已保留进度，请检查提示块类型和格式。");
      }
    }
    const record = existing ?? this.createRecord(entry, now, tags, events);
    record.sourcePath = entry.file.path;
    record.sourceTitle = entry.file.basename;
    record.tags = [...new Set(tags)].sort();
    record.updatedAt = now.toISOString();
    record.sourceStatus = !parsed || parsed.valid ? "active" : "parse-error";
    const syncWarnings = record.warnings.filter((warning) => warning.startsWith("同步冲突："));
    record.warnings = [...syncWarnings, ...(parsed?.warnings ?? [])];
    if (parsed?.valid) this.reconcileCards(record, parsed.cards, events, now);
    return record;
  }

  private createRecord(
    entry: IdentifiedFile,
    now: Date,
    tags: string[],
    events: HistoryEvent[],
  ): SourceRecord {
    const introducedAt = new Date(entry.file.stat.ctime || now.getTime()).toISOString();
    const baseRevision = this.knownRevision(entry.reviewId, "note");
    const note = this.createItem({
      id: "note",
      kind: "note",
      introducedAt,
      hash: entry.reviewId,
      question: entry.file.basename,
      answer: "",
      raw: entry.file.path,
      startLine: 0,
      endLine: 0,
      revision: baseRevision + 1,
      now,
    });
    events.push(
      this.event(entry.reviewId, note.id, "create", baseRevision, note, undefined, now),
    );
    return {
      schemaVersion: 1,
      reviewId: entry.reviewId,
      sourcePath: entry.file.path,
      sourceTitle: entry.file.basename,
      sourceCreatedAt: introducedAt,
      updatedAt: now.toISOString(),
      tags,
      sourceStatus: "active",
      warnings: [],
      note,
      cards: {},
      tombstones: {},
    };
  }

  private reconcileCards(
    record: SourceRecord,
    drafts: ParsedCardDraft[],
    events: HistoryEvent[],
    now: Date,
  ): void {
    const seen = new Set<string>();
    const duplicateKeys = new Set<string>();
    for (const draft of drafts) {
      if (!draft.blockId) continue;
      const itemId = draft.kind === "qa" ? `${draft.blockId}:qa` : `${draft.blockId}:c${draft.clozeIndex}`;
      if (seen.has(itemId)) {
        duplicateKeys.add(itemId);
        continue;
      }
      seen.add(itemId);
      const existing = record.cards[itemId];
      if (!existing) {
        const baseRevision = Math.max(
          record.tombstones[itemId] ?? 0,
          this.knownRevision(record.reviewId, itemId),
        );
        const item = this.createItem({
          id: itemId,
          kind: draft.kind,
          blockId: draft.blockId,
          clozeIndex: draft.clozeIndex,
          introducedAt: record.sourceCreatedAt,
          hash: draft.hash,
          question: draft.content.question,
          answer: draft.content.answer,
          raw: draft.content.raw,
          startLine: draft.content.sourceStartLine,
          endLine: draft.content.sourceEndLine,
          revision: baseRevision + 1,
          now,
        });
        record.cards[itemId] = item;
        delete record.tombstones[itemId];
        events.push(this.event(record.reviewId, itemId, "create", baseRevision, item, undefined, now));
        continue;
      }

      existing.content = draft.content;
      existing.blockId = draft.blockId;
      existing.clozeIndex = draft.clozeIndex;
      if (existing.status === "removed") {
        existing.acceptedHash = draft.hash;
        delete existing.pendingHash;
      } else if (existing.acceptedHash !== draft.hash) {
        existing.pendingHash = draft.hash;
        existing.status = "pending-change";
      }
    }

    for (const itemId of duplicateKeys) {
      record.warnings.push(`卡片 ID 重复：${itemId}；相关卡片已暂停，等待修复。`);
      if (record.cards[itemId]) record.cards[itemId].status = "suspended";
    }

    for (const [itemId, item] of Object.entries(record.cards)) {
      if (seen.has(itemId) || item.status === "removed") continue;
      events.push(this.event(record.reviewId, itemId, "delete", item.revision, null, undefined, now));
      record.tombstones[itemId] = item.revision + 1;
      delete record.cards[itemId];
    }
  }

  private createItem(options: {
    id: string;
    kind: ReviewItem["kind"];
    blockId?: string;
    clozeIndex?: number;
    introducedAt: string;
    hash: string;
    question: string;
    answer: string;
    raw: string;
    startLine: number;
    endLine: number;
    revision: number;
    now: Date;
  }): ReviewItem {
    return {
      id: options.id,
      kind: options.kind,
      ...(options.blockId ? { blockId: options.blockId } : {}),
      ...(options.clozeIndex ? { clozeIndex: options.clozeIndex } : {}),
      revision: options.revision,
      introducedAt: options.introducedAt,
      acceptedHash: options.hash,
      content: {
        question: options.question,
        answer: options.answer,
        raw: options.raw,
        sourceStartLine: options.startLine,
        sourceEndLine: options.endLine,
      },
      schedule: createSchedule(options.now),
      status: "active",
    };
  }

  private deleteRecordItems(record: SourceRecord): HistoryEvent[] {
    const now = new Date();
    return [record.note, ...Object.values(record.cards)].map((item) =>
      this.event(record.reviewId, item.id, "delete", item.revision, null, undefined, now),
    );
  }

  private event(
    sourceId: string,
    itemId: string,
    action: HistoryEvent["action"],
    baseRevision: number,
    after: ReviewItem | null,
    rating?: number,
    now?: Date,
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
      now,
    });
  }

  private collectKnownIdentityPaths(files: TFile[], records: Map<string, SourceRecord>): Map<string, string> {
    const result = new Map<string, string>();
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const value = readReviewId(this.app.metadataCache.getFileCache(file)?.frontmatter);
      if (value && (!result.has(value) || records.get(value)?.sourcePath === file.path)) result.set(value, file.path);
    }
    return result;
  }

  private async ensureReviewId(file: TFile): Promise<string> {
    const cached = readReviewId(this.app.metadataCache.getFileCache(file)?.frontmatter);
    if (cached) return cached;
    let reviewId = createId("note");
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      reviewId = readReviewId(frontmatter) ?? reviewId;
      Reflect.set(frontmatter, "review_id", reviewId);
    });
    return reviewId;
  }

  private async setReviewId(file: TFile, reviewId: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (typeof frontmatter === "object" && frontmatter !== null) {
        Reflect.set(frontmatter, "review_id", reviewId);
      }
    });
  }

  private knownRevision(sourceId: string, itemId: string): number {
    return this.knownRevisions.get(`${sourceId}::${itemId}`) ?? 0;
  }
}

function recordSignature(record: SourceRecord): string {
  return JSON.stringify({ ...record, updatedAt: "" });
}

function readReviewId(frontmatter: unknown): string | undefined {
  if (typeof frontmatter !== "object" || frontmatter === null) return undefined;
  const value: unknown = Reflect.get(frontmatter, "review_id");
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectLatestRevisions(history: HistoryEvent[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const event of history) {
    const key = `${event.sourceId}::${event.itemId}`;
    result.set(key, Math.max(result.get(key) ?? 0, event.nextRevision));
  }
  return result;
}
