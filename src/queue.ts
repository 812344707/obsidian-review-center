import type {
  HistoryEvent,
  QueueCounts,
  QueueEntry,
  ReviewCenterSettings,
  ReviewMode,
  SourceRecord,
} from "./types";
import { isDueSchedule, isNewSchedule } from "./scheduler";
import { itemKey, localDayKey } from "./utils";

export function collectEntries(records: SourceRecord[], mode: ReviewMode): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const record of records) {
    if (record.sourceStatus !== "active") continue;
    const items = mode === "note" ? [record.note] : Object.values(record.cards);
    for (const item of items) {
      if (item.status !== "active") continue;
      entries.push({
        sourceId: record.reviewId,
        sourcePath: record.sourcePath,
        sourceTitle: record.sourceTitle,
        tags: record.tags,
        item,
        isNew: isNewSchedule(item.schedule),
      });
    }
  }
  return entries;
}

export function buildDailyQueue(
  records: SourceRecord[],
  history: HistoryEvent[],
  settings: ReviewCenterSettings,
  mode: ReviewMode,
  now = new Date(),
  extra = false,
): QueueEntry[] {
  const entries = collectEntries(records, mode);
  const reviewedToday = reviewedItemKeys(history, now);
  const due = entries
    .filter((entry) => !entry.isNew && isDueSchedule(entry.item.schedule, now))
    .sort(compareDue);
  const fresh = entries.filter((entry) => entry.isNew).sort(compareNew);

  if (extra) {
    const future = entries
      .filter((entry) => !entry.isNew && !isDueSchedule(entry.item.schedule, now))
      .sort(compareDue);
    return uniqueEntries([...due, ...fresh, ...future]);
  }

  const reviewLimit = mode === "note" ? settings.noteReviewLimit : settings.cardReviewLimit;
  const newLimit = mode === "note" ? settings.noteNewLimit : settings.cardNewLimit;
  const repeatedDue = due.filter((entry) => reviewedToday.has(entryKey(entry)));
  const firstDue = due
    .filter((entry) => !reviewedToday.has(entryKey(entry)))
    .slice(0, reviewLimit);
  const alreadyIntroduced = fresh.filter((entry) => reviewedToday.has(entryKey(entry)));
  const newToday = fresh
    .filter((entry) => !reviewedToday.has(entryKey(entry)))
    .slice(0, newLimit);
  return uniqueEntries([...repeatedDue, ...firstDue, ...alreadyIntroduced, ...newToday]);
}

export function getQueueCounts(
  records: SourceRecord[],
  mode: ReviewMode,
  now = new Date(),
): QueueCounts {
  const allModeItems = records.flatMap((record) =>
    mode === "note" ? [record.note] : Object.values(record.cards),
  );
  const activeEntries = collectEntries(records, mode);
  return {
    due: activeEntries.filter(
      (entry) => !entry.isNew && isDueSchedule(entry.item.schedule, now),
    ).length,
    new: activeEntries.filter((entry) => entry.isNew).length,
    suspended: allModeItems.filter((item) => item.status === "suspended").length,
    pendingChanges: allModeItems.filter((item) => item.status === "pending-change").length,
    warnings: records.reduce((sum, record) => sum + record.warnings.length, 0),
  };
}

function reviewedItemKeys(history: HistoryEvent[], now: Date): Set<string> {
  const today = localDayKey(now);
  const reviewed = new Set<string>();
  for (const event of history) {
    if (localDayKey(new Date(event.occurredAt)) !== today) continue;
    const key = itemKey(event.sourceId, event.itemId);
    if (event.action === "review") reviewed.add(key);
    if (event.action === "undo") reviewed.delete(key);
  }
  return reviewed;
}

function compareDue(left: QueueEntry, right: QueueEntry): number {
  const byDue = new Date(left.item.schedule.due).getTime() - new Date(right.item.schedule.due).getTime();
  return byDue || compareStable(left, right);
}

function compareNew(left: QueueEntry, right: QueueEntry): number {
  const byIntroduced =
    new Date(left.item.introducedAt).getTime() - new Date(right.item.introducedAt).getTime();
  return byIntroduced || compareStable(left, right);
}

function compareStable(left: QueueEntry, right: QueueEntry): number {
  return (
    left.sourcePath.localeCompare(right.sourcePath, "zh-CN") ||
    left.item.content.sourceStartLine - right.item.content.sourceStartLine ||
    left.item.id.localeCompare(right.item.id)
  );
}

function entryKey(entry: QueueEntry): string {
  return itemKey(entry.sourceId, entry.item.id);
}

function uniqueEntries(entries: QueueEntry[]): QueueEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
