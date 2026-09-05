import { getAllTags, TFile, type App } from "obsidian";
import { parse } from "yaml";
import { normalizeTags, resolveGroup } from "./config";
import { reconcileRecordsWithHistory } from "./history";
import { parseReviewCallouts } from "./parser";
import type { ReviewStore } from "./storage";
import type { HistoryEvent, ReviewCenterSettings, SourceRecord } from "./types";
import { hashText, pathIsInside } from "./utils";

export interface VerifiedSource {
  record: SourceRecord | null;
  history: HistoryEvent[];
  sourceHash: string;
}

/** Read the current source and persisted progress. This never trusts a cached card for grading. */
export async function verifySource(
  app: App, store: ReviewStore, settings: ReviewCenterSettings,
  source: SourceRecord, itemId: string,
  assertMetadataCurrent: (path: string, markdown: string) => void,
): Promise<VerifiedSource> {
  const history = await store.loadAllHistory(undefined, true);
  const stored = await store.loadRecord(source.reviewId, true);
  if (!stored) throw new Error("当前条目的进度文件暂不可用，请等待同步完成或整理材料后重试。");
  const record = reconcileRecordsWithHistory([stored], history).records[0];
  const direct = app.vault.getAbstractFileByPath(record.sourcePath);
  let file = direct instanceof TFile && !pathIsInside(direct.path, settings.dataFolder) &&
    app.metadataCache.getFileCache(direct)?.frontmatter?.review_id === source.reviewId ? direct : undefined;
  if (!file) {
    // Only a missing/moved identity needs a vault metadata lookup; the usual path reads one file.
    const files = app.vault.getMarkdownFiles();
    const candidates = files.filter((file) => !pathIsInside(file.path, settings.dataFolder) &&
      app.metadataCache.getFileCache(file)?.frontmatter?.review_id === source.reviewId);
    if (candidates.length === 1) file = candidates[0];
    if (!file) {
      if (candidates.length > 1) throw new Error("来源笔记存在重复标识，请先整理材料并核对。");
      if (files.some((file) => file.path === record.sourcePath || !app.metadataCache.getFileCache(file))) {
        throw new Error("来源笔记的索引尚未就绪，请稍后重试或整理材料。");
      }
      record.sourceStatus = "deleted";
      return { record, history, sourceHash: "" };
    }
  }
  const markdown = await app.vault.read(file);
  assertMetadataCurrent(file.path, markdown);
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) throw new Error("来源笔记的索引尚未就绪，请稍后重试。");
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  const properties = frontmatter ? parse(frontmatter[1]) : null;
  if (!properties || properties.review_id !== source.reviewId) {
    throw new Error("来源笔记的标识发生变化，请先整理材料。");
  }
  const propertyTags = (value: unknown): string[] => normalizeTags(
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") :
      typeof value === "string" ? value.split(/[\s,，]+/) : [],
  ).sort();
  if (JSON.stringify(propertyTags(properties.tags)) !== JSON.stringify(propertyTags(cache.frontmatter?.tags)) ||
    cache.tags?.some((tag) => markdown.slice(tag.position.start.offset, tag.position.end.offset) !== tag.tag)) {
    throw new Error("笔记标签正在更新，请稍后重试。");
  }
  record.sourcePath = file.path;
  record.sourceTitle = file.basename;
  record.tags = [...new Set(getAllTags(cache) ?? [])].sort();
  record.sourceStatus = resolveGroup(record.tags, settings.noteGroups) || resolveGroup(record.tags, settings.cardGroups) ? "active" : "out-of-scope";
  if (itemId !== "note" && record.cards[itemId]) {
    const parsed = parseReviewCallouts(markdown, settings.reviewCalloutTypes);
    if (!parsed.valid) {
      record.sourceStatus = "parse-error";
      record.warnings = parsed.warnings;
    } else {
      const matches = parsed.cards.filter((draft) => draft.blockId &&
        `${draft.blockId}:${draft.kind === "qa" ? "qa" : "c" + draft.clozeIndex}` === itemId);
      const item = record.cards[itemId];
      if (matches.length !== 1) item.status = matches.length ? "suspended" : "removed";
      else {
        item.content = matches[0].content;
        if (item.acceptedHash !== matches[0].hash) {
          item.pendingHash = matches[0].hash;
          item.status = "pending-change";
        }
      }
    }
  }
  return { record, history, sourceHash: hashText(markdown) };
}
