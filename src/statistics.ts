import { effectiveReviews, eventMode } from "./activity";
import { groupsFor, resolveGroup, tagsMatch } from "./config";
import { collectEntries } from "./queue";
import type { HistoryEvent, ReviewCenterSettings, ReviewMode, SerializedFsrsCard, SourceRecord } from "./types";
import { itemKey, localDayKey } from "./utils";

export interface StatisticsScope { mode: ReviewMode; groupId?: string; tagPath?: string }
export interface ActivityDay {
  date: string;
  fresh: number;
  reviewed: number;
  unclassified: number;
  attempts: number;
  durationMs: number;
  timed: number;
}
export interface RetentionSummary { days: number; passed: number; failed: number; unknown: number }
export interface DueDay { date: string; count: number }
export interface ReviewStatistics {
  today: ActivityDay;
  activity: ActivityDay[];
  retention: RetentionSummary[];
  forecast: DueDay[];
  overdue: number;
  dueToday: number;
  deferred: number;
  invalidDue: number;
  history: HistoryEvent[];
}

/** Local calendar arithmetic also works on 23/25-hour daylight-saving days. */
export function calendarDate(now: Date, offset: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
}

export function scopeHistory(history: HistoryEvent[], records: SourceRecord[], settings: ReviewCenterSettings, scope: StatisticsScope): HistoryEvent[] {
  const sources = new Map(records.map((r) => [r.reviewId, r]));
  return history.filter((event) => {
    if (eventMode(event) !== scope.mode) return false;
    if (!scope.groupId && !scope.tagPath) return true;
    const record = sources.get(event.sourceId);
    const tags = event.sourceTags ?? record?.tags ?? [];
    const groupId = event.groupId ?? resolveGroup(tags, groupsFor(settings, scope.mode), record?.sourcePath)?.id;
    return (!scope.groupId || groupId === scope.groupId) && tagsMatch(tags, scope.tagPath);
  });
}

/** Old histories contain post-event snapshots; only an unambiguous predecessor is usable. */
function previousSchedule(event: HistoryEvent, snapshots: Map<string, HistoryEvent[]>): SerializedFsrsCard | undefined {
  if (event.beforeSchedule) return event.beforeSchedule;
  const candidates = (snapshots.get(`${itemKey(event.sourceId, event.itemId)}::${event.baseRevision}`) ?? [])
    .filter((e) => e.eventId !== event.eventId && e.after?.schedule && new Date(e.occurredAt).getTime() <= new Date(event.occurredAt).getTime());
  const schedules = new Map(candidates.map((e) => [JSON.stringify(e.after!.schedule), e.after!.schedule]));
  return schedules.size === 1 ? [...schedules.values()][0] : undefined;
}

function wasNew(event: HistoryEvent, before?: SerializedFsrsCard): boolean | undefined {
  if (typeof event.wasNew === "boolean") return event.wasNew;
  if (before && Number.isFinite(before.state) && Number.isFinite(before.reps)) return before.state === 0 && before.reps === 0;
  const reps = event.after?.schedule?.reps;
  return reps === undefined || reps < 1 ? undefined : reps === 1;
}

export function buildStatistics(records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings, scope: StatisticsScope, now = new Date()): ReviewStatistics {
  const todayKey = localDayKey(now);
  const activity: ActivityDay[] = Array.from({ length: 365 }, (_, i) => ({ date: localDayKey(calendarDate(now, i - 364)), fresh: 0, reviewed: 0, unclassified: 0, attempts: 0, durationMs: 0, timed: 0 }));
  const byDate = new Map(activity.map((day) => [day.date, day]));
  const unique = new Map(history.filter((e) => e.eventId && Number.isFinite(new Date(e.occurredAt).getTime()) && new Date(e.occurredAt).getTime() <= now.getTime()).map((e) => [e.eventId, e]));
  const snapshots = new Map<string, HistoryEvent[]>();
  for (const event of unique.values()) {
    const key = `${itemKey(event.sourceId, event.itemId)}::${event.nextRevision}`;
    const values = snapshots.get(key) ?? []; values.push(event); snapshots.set(key, values);
  }
  // Resolve undo globally before narrowing the scope: an undo may lack old group/tag metadata.
  const valid = effectiveReviews([...unique.values()]);
  const scoped = scopeHistory(valid, records, settings, scope);
  const selected = new Set(scoped.map((event) => event.eventId));
  const firstToday = new Set<string>();
  const retention = [7, 30, 365].map((days) => ({ days, passed: 0, failed: 0, unknown: 0 }));
  const starts = retention.map((r) => localDayKey(calendarDate(now, 1 - r.days)));
  for (const event of valid) {
    const date = localDayKey(new Date(event.occurredAt));
    const key = `${itemKey(event.sourceId, event.itemId)}::${date}`;
    const first = !firstToday.has(key); firstToday.add(key);
    if (!selected.has(event.eventId)) continue;
    const day = byDate.get(date);
    if (!day) continue;
    const before = previousSchedule(event, snapshots);
    const fresh = wasNew(event, before);
    day.attempts++;
    if (Number.isFinite(event.durationMs) && event.durationMs! >= 0) {
      day.durationMs += Math.min(300000, event.durationMs!); day.timed++;
    }
    if (!first) continue;
    if (fresh === true) day.fresh++;
    else if (fresh === false) day.reviewed++;
    else day.unclassified++;
    if (fresh === true) continue;
    const last = before?.last_review ? new Date(before.last_review).getTime() : NaN;
    const elapsed = new Date(event.occurredAt).getTime() - last;
    // Self-rated delayed recall, not a model prediction or same-day learning success rate.
    if (Number.isFinite(last) && elapsed < 86400000 && elapsed >= 0) continue;
    for (const [i, result] of retention.entries()) {
      if (date < starts[i]) continue;
      if (!Number.isFinite(last) || elapsed < 0) result.unknown++;
      else if (event.rating === 1) result.failed++;
      else result.passed++;
    }
  }
  const forecast = Array.from({ length: 30 }, (_, i) => ({ date: localDayKey(calendarDate(now, i + 1)), count: 0 }));
  const future = new Map(forecast.map((day) => [day.date, day]));
  let overdue = 0, dueToday = 0, deferred = 0, invalidDue = 0;
  const seen = new Set<string>();
  for (const entry of collectEntries(records, scope.mode, settings, scope.groupId, scope.tagPath)) {
    const key = itemKey(entry.sourceId, entry.item.id);
    if (seen.has(key) || entry.isNew) continue;
    seen.add(key);
    const due = new Date(entry.item.schedule.due);
    if (!Number.isFinite(due.getTime())) { invalidDue++; continue; }
    let day = localDayKey(due);
    const buried = entry.item.buriedUntil;
    if (buried && /^\d{4}-\d{2}-\d{2}$/.test(buried) && buried > todayKey) {
      deferred++; if (buried > day) day = buried;
    }
    if (day < todayKey) overdue++;
    else if (day === todayKey) dueToday++;
    else { const bucket = future.get(day); if (bucket) bucket.count++; }
  }
  return { today: activity[364], activity, retention, forecast, overdue, dueToday, deferred, invalidDue, history: scoped };
}

export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒`;
  const minutes = ms / 60000;
  return minutes < 60 ? `${Number(minutes.toFixed(1))} 分钟` : `${Math.floor(minutes / 60)} 小时 ${Math.floor(minutes % 60)} 分`;
}

export function activityDuration(day: Pick<ActivityDay, "attempts" | "timed" | "durationMs">): string {
  return day.attempts > 0 && day.timed === 0 ? "未记录" : formatDuration(day.durationMs);
}
