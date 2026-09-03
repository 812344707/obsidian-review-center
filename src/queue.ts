import type { HistoryEvent, QueueCounts, QueueEntry, ReviewCenterSettings, ReviewMode, SourceRecord } from "./types";
import { isDueSchedule, isNewSchedule } from "./scheduler";
import { groupsFor, resolveGroup } from "./config";
import { effectiveReviews, eventMode } from "./activity";
import { itemKey, localDayKey } from "./utils";

export function collectEntries(records: SourceRecord[], mode: ReviewMode, settings: ReviewCenterSettings, groupId?: string): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const record of records) {
    if (record.sourceStatus !== "active" && !(mode === "note" && record.sourceStatus === "parse-error")) continue;
    const group = resolveGroup(record.tags, groupsFor(settings, mode));
    if (!group || (groupId && group.id !== groupId)) continue;
    const items = mode === "note" ? [record.note] : Object.values(record.cards);
    for (const item of items) {
      if (item.status !== "active") continue;
      entries.push({ group, sourceId: record.reviewId, sourcePath: record.sourcePath, sourceTitle: record.sourceTitle,
        tags: record.tags, item, isNew: isNewSchedule(item.schedule) });
    }
  }
  return entries;
}

export function buildDailyQueue(
  records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings,
  mode: ReviewMode, now = new Date(), extra = false, groupId?: string,
): QueueEntry[] {
  const entries = collectEntries(records, mode, settings, groupId);
  const due = entries.filter((entry) => !entry.isNew && isDueSchedule(entry.item.schedule, now)).sort(compareDue);
  const fresh = entries.filter((entry) => entry.isNew).sort(compareNew);
  if (extra) {
    const future = entries.filter((entry) => !entry.isNew && !isDueSchedule(entry.item.schedule, now)).sort(compareDue);
    return [...due, ...fresh, ...future];
  }
  const today = localDayKey(now);
  const reviewed = new Set<string>();
  const used = new Map<string, { fresh: number; due: number }>();
  const recordMap = new Map(records.map((record) => [record.reviewId, record]));
  for (const event of effectiveReviews(history)) {
    if (eventMode(event) !== mode || localDayKey(new Date(event.occurredAt)) !== today) continue;
    const key = itemKey(event.sourceId, event.itemId);
    if (reviewed.has(key)) continue;
    reviewed.add(key);
    // Older logs predate groups; assign their day usage to their current scope.
    const group = event.groupId ?? resolveGroup(recordMap.get(event.sourceId)?.tags ?? [], groupsFor(settings, mode))?.id;
    if (!group) continue;
    const count = used.get(group) ?? { fresh: 0, due: 0 };
    if (event.wasNew ?? event.after?.schedule.reps === 1) count.fresh += 1;
    else count.due += 1;
    used.set(group, count);
  }
  const take = (candidates: QueueEntry[], type: "fresh" | "due") => candidates.filter((entry) => {
    if (reviewed.has(entryKey(entry))) return true;
    const count = used.get(entry.group.id) ?? { fresh: 0, due: 0 };
    const limit = type === "fresh" ? entry.group.parameters.newLimit : entry.group.parameters.reviewLimit;
    if (count[type] >= limit) return false;
    count[type] += 1;
    used.set(entry.group.id, count);
    return true;
  });
  const repeated = due.filter((entry) => reviewed.has(entryKey(entry)));
  const firstDue = due.filter((entry) => !reviewed.has(entryKey(entry)));
  return [...repeated, ...take(firstDue, "due"), ...take(fresh, "fresh")];
}

export function getQueueCounts(records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings,
  mode: ReviewMode, now = new Date(), groupId?: string): QueueCounts {
  const queue = buildDailyQueue(records, history, settings, mode, now, false, groupId);
  const scoped = records.filter((record) => {
    const group = resolveGroup(record.tags, groupsFor(settings, mode));
    return group && (!groupId || group.id === groupId);
  });
  const items = scoped.flatMap((record) => mode === "note" ? [record.note] : Object.values(record.cards));
  return {
    due: queue.filter((entry) => !entry.isNew).length, new: queue.filter((entry) => entry.isNew).length,
    suspended: items.filter((item) => item.status === "suspended").length,
    pendingChanges: items.filter((item) => item.status === "pending-change").length,
    warnings: scoped.reduce((sum, record) => sum + record.warnings.length, 0),
  };
}

function compareDue(left: QueueEntry, right: QueueEntry): number {
  return new Date(left.item.schedule.due).getTime() - new Date(right.item.schedule.due).getTime() || compareStable(left, right);
}
function compareNew(left: QueueEntry, right: QueueEntry): number {
  return new Date(left.item.introducedAt).getTime() - new Date(right.item.introducedAt).getTime() || compareStable(left, right);
}
function compareStable(left: QueueEntry, right: QueueEntry): number {
  return left.sourcePath.localeCompare(right.sourcePath, "zh-CN") ||
    left.item.content.sourceStartLine - right.item.content.sourceStartLine || left.item.id.localeCompare(right.item.id);
}
function entryKey(entry: QueueEntry): string { return itemKey(entry.sourceId, entry.item.id); }
