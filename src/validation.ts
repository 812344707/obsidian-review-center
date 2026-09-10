import type { FullBackup, HistoryEvent, ReviewItem, ReviewSession, SerializedFsrsCard, SourceRecord, UndoEntry } from "./types";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
const reserved = new Set(["__proto__", "prototype", "constructor"]);
export function isSourceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]+$/i.test(value) && !reserved.has(value);
}
function isItemId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_:-]+$/i.test(value) && !reserved.has(value);
}
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function isSchedule(value: unknown): value is SerializedFsrsCard {
  return isObject(value) && date(value.due) && (value.last_review === undefined || date(value.last_review)) &&
    [value.stability, value.difficulty, value.elapsed_days, value.scheduled_days].every(finite) &&
    [value.learning_steps, value.reps, value.lapses].every(integer) && integer(value.state) && value.state <= 3;
}

export function isReviewItem(value: unknown): value is ReviewItem {
  if (!isObject(value) || !isItemId(value.id) || !integer(value.revision) || !date(value.introducedAt) ||
    typeof value.acceptedHash !== "string" || !isSchedule(value.schedule) || !isObject(value.content)) return false;
  const content = value.content;
  return ["note", "qa", "cloze"].includes(String(value.kind)) && (value.kind === "note") === (value.id === "note") &&
    ["active", "suspended", "removed", "pending-change"].includes(String(value.status)) &&
    [content.question, content.answer, content.raw].every(v => typeof v === "string") &&
    integer(content.sourceStartLine) && integer(content.sourceEndLine) &&
    (value.lastReviewedAt === undefined || date(value.lastReviewedAt)) &&
    (value.pendingHash === undefined || typeof value.pendingHash === "string") &&
    (value.buriedUntil === undefined || date(value.buriedUntil));
}

export function assertSourceRecord(value: unknown): asserts value is SourceRecord {
  if (!isObject(value) || value.schemaVersion !== 1 || !isSourceId(value.reviewId) ||
    typeof value.sourcePath !== "string" || !value.sourcePath || typeof value.sourceTitle !== "string" ||
    !date(value.sourceCreatedAt) || !date(value.updatedAt) || !isStringList(value.tags) || !isStringList(value.warnings) ||
    (value.sourceHash !== undefined && (typeof value.sourceHash !== "string" || !/^[0-9a-f]{8}$/.test(value.sourceHash))) ||
    (value.sourceModifiedAt !== undefined && !integer(value.sourceModifiedAt)) ||
    (value.sourceSize !== undefined && !integer(value.sourceSize)) ||
    (value.sourceScanSignature !== undefined && (typeof value.sourceScanSignature !== "string" || !value.sourceScanSignature)) ||
    !["active", "out-of-scope", "deleted", "parse-error"].includes(String(value.sourceStatus)) ||
    !isReviewItem(value.note) || value.note.id !== "note" || !isObject(value.cards) || !isObject(value.tombstones) ||
    !Object.entries(value.cards).every(([id, card]) => id !== "note" && isReviewItem(card) && card.id === id) ||
    !Object.entries(value.tombstones).every(([id, revision]) => isItemId(id) && integer(revision))) {
    throw new Error("复习记录格式、标识或排程无效，原有数据未被替换。");
  }
}

export function assertHistoryEvent(value: unknown): asserts value is HistoryEvent {
  if (!isObject(value) || value.schemaVersion !== 1 || !isSourceId(value.eventId) || !isSourceId(value.sourceId) ||
    typeof value.sessionId !== "string" || typeof value.deviceId !== "string" || !isItemId(value.itemId) ||
    !date(value.occurredAt) || !integer(value.baseRevision) || !integer(value.nextRevision) || value.nextRevision <= value.baseRevision ||
    !["create", "review", "undo", "reset", "suspend", "resume", "remove", "delete", "change-keep", "change-reset", "bury", "unbury", "reschedule"].includes(String(value.action)) ||
    !(value.after === null ? value.action === "delete" : isReviewItem(value.after) && value.after.id === value.itemId && value.after.revision === value.nextRevision) ||
    (value.rating !== undefined && (!integer(value.rating) || value.rating < 1 || value.rating > 4)) ||
    (value.beforeSchedule !== undefined && !isSchedule(value.beforeSchedule))) {
    throw new Error("评分历史格式、标识或排程无效，请等待同步完成或核对备份。");
  }
}

export function assertBackup(value: unknown): asserts value is FullBackup {
  if (!isObject(value) || ![1, 2, 3, 4].some(version => version === value.schemaVersion) ||
    !Array.isArray(value.records) || !Array.isArray(value.history) || !isObject(value.settings) ||
    (value.kind !== undefined && value.kind !== "full" && value.kind !== "scope")) throw new Error("备份格式或版本无效。");
  const ids = new Set<string>();
  for (const record of value.records) {
    assertSourceRecord(record);
    if (ids.has(record.reviewId)) throw new Error("备份包含重复的来源标识，未恢复。");
    ids.add(record.reviewId);
  }
  for (const event of value.history) assertHistoryEvent(event);
  if (value.kind === "scope" && (!isObject(value.scope) || !["note", "card"].includes(String(value.scope.mode)) ||
    typeof value.scope.groupId !== "string" || !isStringList(value.itemKeys))) throw new Error("范围备份缺少有效的范围信息。");
}

export function isReviewSession(value: unknown): value is ReviewSession {
  return isObject(value) && isSourceId(value.id) && (value.mode === "note" || value.mode === "card") &&
    isStringList(value.entryKeys) && value.entryKeys.every(key => {
      const parts = key.split("::"); return parts.length === 2 && isSourceId(parts[0]) && isItemId(parts[1]);
    }) && integer(value.currentIndex) && value.currentIndex <= value.entryKeys.length &&
    typeof value.answerVisible === "boolean" && date(value.startedAt) &&
    (value.currentStartedAt === undefined || date(value.currentStartedAt)) &&
    (value.currentElapsedMs === undefined || finite(value.currentElapsedMs)) &&
    (value.groupId === undefined || typeof value.groupId === "string") &&
    (value.tagPath === undefined || typeof value.tagPath === "string");
}
export function isUndoEntry(value: unknown): value is UndoEntry {
  return isObject(value) && isSourceId(value.eventId) && isSourceId(value.sourceId) && isItemId(value.itemId) &&
    isReviewItem(value.before) && isReviewItem(value.after) && value.before.id === value.itemId && value.after.id === value.itemId &&
    (value.siblings === undefined || Array.isArray(value.siblings) && value.siblings.every((sibling: unknown) =>
      isObject(sibling) && isSourceId(sibling.eventId) && isReviewItem(sibling.before) && isReviewItem(sibling.after) && sibling.before.id === sibling.after.id));
}
