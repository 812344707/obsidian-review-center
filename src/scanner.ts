import { App, TFile, getAllTags } from "obsidian";
import { createHistoryEvent, reconcileRecordsWithHistory } from "./history";
import { insertMissingBlockIds, parseReviewSection } from "./parser";
import { createSchedule } from "./scheduler";
import { ReviewStore } from "./storage";
import type {
  HistoryEvent,
  ParsedCardDraft,
  ReviewCenterSettings,
  ReviewItem,
  SourceRecord,
} from "./types";
import { createId, isWatchedPath } from "./utils";

interface IdentifiedFile {
  file: TFile;
  reviewId: string;
}

export interface ScanResult {
  records: SourceRecord[];
  history: HistoryEvent[];
  conflicts: number;
}

export class VaultScanner {
  private knownRevisions = new Map<string, number>();

  constructor(
    private readonly app: App,
    private readonly store: ReviewStore,
    private readonly getSettings: () => ReviewCenterSettings,
  ) {}

  async scan(): Promise<ScanResult> {
    await this.store.initialize();
    const history = await this.store.loadAllHistory();
    this.knownRevisions = collectLatestRevisions(history);
    const loaded = await this.store.loadAllRecords();
    const reconciled = reconcileRecordsWithHistory(loaded, history);
    const recordById = new Map(reconciled.records.map((record) => [record.reviewId, record]));
    const settings = this.getSettings();
    const allMarkdown = this.app.vault.getMarkdownFiles();
    const outsideIdentityPaths = this.collectKnownIdentityPaths(allMarkdown);
    const watchedFiles = allMarkdown.filter((file) =>
      isWatchedPath(file.path, settings.watchedFolders, settings.excludedFolders, settings.dataFolder),
    );
    const identified = await this.identifyWatchedFiles(watchedFiles, recordById);
    const activeIds = new Set<string>();
    const resultRecords: SourceRecord[] = [];

    for (const entry of identified) {
      const fileEvents: HistoryEvent[] = [];
      const record = await this.scanFile(entry, recordById.get(entry.reviewId), fileEvents);
      activeIds.add(record.reviewId);
      resultRecords.push(record);
      await this.store.appendHistory(fileEvents);
      history.push(...fileEvents);
      await this.store.saveRecord(record);
    }

    for (const record of reconciled.records) {
      if (activeIds.has(record.reviewId)) continue;
      const outsidePath = outsideIdentityPaths.get(record.reviewId);
      if (outsidePath) {
        record.sourcePath = outsidePath;
        record.sourceTitle = outsidePath.split("/").at(-1)?.replace(/\.md$/i, "") ?? outsidePath;
        record.sourceStatus = "out-of-scope";
        record.updatedAt = new Date().toISOString();
        resultRecords.push(record);
        await this.store.saveRecord(record);
      } else {
        const deleteEvents = this.deleteRecordItems(record);
        await this.store.appendHistory(deleteEvents);
        history.push(...deleteEvents);
        await this.store.deleteRecord(record.reviewId);
      }
    }

    return {
      records: resultRecords,
      history,
      conflicts: reconciled.conflicts,
    };
  }

  private async identifyWatchedFiles(
    files: TFile[],
    records: Map<string, SourceRecord>,
  ): Promise<IdentifiedFile[]> {
    const entries: IdentifiedFile[] = [];
    for (const file of files) {
      entries.push({ file, reviewId: await this.ensureReviewId(file) });
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
  ): Promise<SourceRecord> {
    const settings = this.getSettings();
    let markdown = await this.app.vault.read(entry.file);
    let parsed = parseReviewSection(markdown, settings.reviewHeading, settings.reviewHeadingLevel);
    if (parsed.valid && parsed.cards.some((draft) => !draft.blockId)) {
      await this.app.vault.process(entry.file, (current) =>
        insertMissingBlockIds(current, parsed.cards, () => createId("rv")),
      );
      markdown = await this.app.vault.read(entry.file);
      parsed = parseReviewSection(markdown, settings.reviewHeading, settings.reviewHeadingLevel);
    }

    const now = new Date();
    const cache = this.app.metadataCache.getFileCache(entry.file);
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    const record = existing ?? this.createRecord(entry, now, tags, events);
    record.sourcePath = entry.file.path;
    record.sourceTitle = entry.file.basename;
    record.tags = [...new Set(tags)].sort();
    record.updatedAt = now.toISOString();
    record.sourceStatus = parsed.valid ? "active" : "parse-error";
    const syncWarnings = record.warnings.filter((warning) => warning.startsWith("同步冲突："));
    record.warnings = [...syncWarnings, ...parsed.warnings];
    if (parsed.valid) this.reconcileCards(record, parsed.cards, events, now);
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

  private collectKnownIdentityPaths(files: TFile[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const file of files) {
      const value = readReviewId(this.app.metadataCache.getFileCache(file)?.frontmatter);
      if (value) result.set(value, file.path);
    }
    return result;
  }

  private async ensureReviewId(file: TFile): Promise<string> {
    const cached = readReviewId(this.app.metadataCache.getFileCache(file)?.frontmatter);
    if (cached) return cached;
    const reviewId = createId("note");
    await this.setReviewId(file, reviewId);
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
