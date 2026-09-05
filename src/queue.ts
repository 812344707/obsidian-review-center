import type { HistoryEvent, QueueCounts, QueueEntry, ReviewCenterSettings, ReviewMode, ReviewParameters, SourceRecord } from "./types";
import { isDueSchedule, isNewSchedule } from "./scheduler";
import { groupsFor, resolveGroup, nodeParameters, parameterPath, tagsMatch, tagMatches, naturalCompare } from "./config";
import { effectiveReviews, eventMode } from "./activity";
import { hashText, itemKey, localDayKey } from "./utils";

export interface DailyQueuePreparation {
  mode: ReviewMode;
  day: string;
  entries: QueueEntry[];
  allGroups: ReturnType<typeof groupsFor>;
  groupRank: Map<string, number>;
  recordMap: Map<string, SourceRecord>;
  reviewed: Set<string>;
  firstReviews: HistoryEvent[];
}

export function prepareDailyQueue(
  records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings, mode: ReviewMode, now = new Date(),
): DailyQueuePreparation {
  const allGroups = groupsFor(settings, mode);
  const reviewed = new Set<string>();
  const reviews = effectiveReviews(history).filter((event) => eventMode(event) === mode &&
    localDayKey(new Date(event.occurredAt)) === localDayKey(now));
  const firstReviews = reviews.filter((event) => {
    const key = itemKey(event.sourceId, event.itemId);
    if (reviewed.has(key)) return false;
    reviewed.add(key);
    return true;
  });
  return {
    mode,
    day: localDayKey(now),
    entries: collectEntries(records, mode, settings).filter((entry) => !isBuried(entry, now)),
    allGroups,
    groupRank: new Map(allGroups.map((group, index) => [group.id, index])),
    recordMap: new Map(records.map((record) => [record.reviewId, record])),
    reviewed,
    firstReviews,
  };
}

export function collectEntries(records: SourceRecord[], mode: ReviewMode, settings: ReviewCenterSettings, groupId?: string, tagPath?: string): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const record of records) {
    if (record.sourceStatus !== "active" && !(mode === "note" && record.sourceStatus === "parse-error")) continue;
    const group = resolveGroup(record.tags, groupsFor(settings, mode), record.sourcePath);
    if (!group || (groupId && group.id !== groupId) || !tagsMatch(record.tags, tagPath)) continue;
    const path = parameterPath(record.tags, group), resolved = nodeParameters(settings, mode, group, path);
    for (const item of mode === "note" ? [record.note] : Object.values(record.cards)) {
      if (item.status !== "active") continue;
      entries.push({ group: { ...group, parameters: resolved.parameters }, presetId: resolved.presetId, tagPath: path,
        sourceId: record.reviewId, sourcePath: record.sourcePath, sourceTitle: record.sourceTitle,
        tags: record.tags, item, isNew: isNewSchedule(item.schedule) });
    }
  }
  return entries;
}
export function isLearning(entry: QueueEntry): boolean { return [1, 3].includes(entry.item.schedule.state); }
export function isBuried(entry: QueueEntry, now: Date): boolean { return !!entry.item.buriedUntil && entry.item.buriedUntil > localDayKey(now); }
export function buildDailyQueue(records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings,
  mode: ReviewMode, now = new Date(), extra = false, groupId?: string, tagPath?: string, seed = localDayKey(now),
  prepared?: DailyQueuePreparation): QueueEntry[] {
  const context = prepared?.mode === mode && prepared.day === localDayKey(now)
    ? prepared : prepareDailyQueue(records, history, settings, mode, now);
  const entries = context.entries.filter((entry) => (!groupId || entry.group.id === groupId) && tagsMatch(entry.tags, tagPath));
  const { allGroups, groupRank, recordMap, reviewed, firstReviews } = context;
  const result: QueueEntry[] = [];
  for (const group of allGroups.filter((g) => !groupId || g.id === groupId)) {
    const order = nodeParameters(settings, mode, group, tagPath ?? "", now).parameters;
    const random = (e: QueueEntry, note = false) => hashText(seed + ":" + group.id + ":" + (note ? e.sourceId : entryKey(e)));
    const stable = (a: QueueEntry, b: QueueEntry) => naturalCompare(a.sourcePath, b.sourcePath) || a.item.content.sourceStartLine - b.item.content.sourceStartLine || a.item.id.localeCompare(b.item.id);
    const byGroup = (a: QueueEntry, b: QueueEntry) => (groupRank.get(a.group.id)! - groupRank.get(b.group.id)!) || naturalCompare(a.tagPath ?? "", b.tagPath ?? "");
    const dueTime = (e: QueueEntry) => new Date(e.item.schedule.due).getTime();
    const retrieval = (e: QueueEntry) => {
      const elapsed = Math.max(0, (now.getTime() - new Date(e.item.schedule.last_review ?? now).getTime()) / 86400000);
      const decay = -(e.group.parameters.weights?.[20] ?? 0.1542), factor = Math.pow(0.9, 1 / decay) - 1;
      return Math.pow(1 + factor * elapsed / Math.max(0.001, e.item.schedule.stability), decay);
    };
    const byDue = (a: QueueEntry, b: QueueEntry): number => {
      const sort = order.reviewSort;
      const delta = sort === "random" ? random(a).localeCompare(random(b)) : sort === "group" ? byGroup(a, b) || dueTime(a) - dueTime(b) :
        sort === "interval" || sort === "interval-desc" ? (a.item.schedule.scheduled_days - b.item.schedule.scheduled_days) * (sort.endsWith("desc") ? -1 : 1) :
        sort === "difficulty" || sort === "difficulty-desc" ? (a.item.schedule.difficulty - b.item.schedule.difficulty) * (sort.endsWith("desc") ? -1 : 1) :
        sort === "retention" || sort === "retention-desc" ? (retrieval(a) - retrieval(b)) * (sort.endsWith("desc") ? -1 : 1) :
        sort === "due-random" ? localDayKey(new Date(a.item.schedule.due)).localeCompare(localDayKey(new Date(b.item.schedule.due))) || random(a).localeCompare(random(b)) : dueTime(a) - dueTime(b);
      return delta || stable(a, b);
    };
    const typeOrder = (e: QueueEntry) => e.item.kind === "cloze" ? 1 + (e.item.clozeIndex ?? 1) : 0;
    const fresh = entries.filter((e) => e.group.id === group.id && e.isNew).sort((a, b) => {
      const sort = order.newGather;
      const delta = sort === "group" ? byGroup(a, b) : sort === "random-card" || order.insertion === "random" ? random(a).localeCompare(random(b)) :
        sort === "random-note" ? random(a, true).localeCompare(random(b, true)) :
        (new Date(a.item.introducedAt).getTime() - new Date(b.item.introducedAt).getTime()) * (sort === "created-desc" ? -1 : 1);
      return delta || stable(a, b);
    });
    const due = entries.filter((e) => e.group.id === group.id && !e.isNew && isDueSchedule(e.item.schedule, now)).sort((a, b) => Number(reviewed.has(entryKey(b))) - Number(reviewed.has(entryKey(a))) || byDue(a, b));
    type Budget = { path: string; p: ReviewParameters; fresh: number; due: number };
    const paths = new Set<string>([tagPath ?? ""]);
    if (tagPath && order.limitsFromTop) paths.add("");
    for (const path of Object.keys(group.nodes ?? {})) {
      if (!tagPath || tagMatches(path, tagPath) || (order.limitsFromTop && tagMatches(tagPath, path))) paths.add(path);
    }
    const budgets: Budget[] = [...paths].map((path) => ({ path, p: nodeParameters(settings, mode, group, path, now).parameters, fresh: 0, due: 0 }));
    for (const event of firstReviews) {
      const record = recordMap.get(event.sourceId);
      const owner = event.groupId ?? resolveGroup(record?.tags ?? [], allGroups, record?.sourcePath)?.id;
      if (owner !== group.id) continue;
      const tags = event.sourceTags ?? record?.tags ?? [];
      for (const budget of budgets) if (!budget.path || tagsMatch(tags, budget.path)) {
        if (event.wasNew ?? event.after?.schedule.reps === 1) budget.fresh++; else budget.due++;
      }
    }
    const take = (candidates: QueueEntry[], kind: "fresh" | "due") => candidates.filter((e) => {
      if (extra || reviewed.has(entryKey(e))) return true;
      const applicable = budgets.filter((b) => !b.path || b.path === tagPath || tagMatches(e.tagPath ?? "", b.path));
      if (applicable.some((b) => kind === "fresh" ? b.fresh >= b.p.newLimit || (!b.p.newIgnoreReviewLimit && b.fresh + b.due >= b.p.reviewLimit) : b.due + (b.p.newIgnoreReviewLimit ? 0 : b.fresh) >= b.p.reviewLimit)) return false;
      applicable.forEach((b) => b[kind]++); return true;
    });
    const selectedDue = take(due, "due"), selectedNew = take(fresh, "fresh");
    const gatherIndex = new Map(selectedNew.map((e, i) => [entryKey(e), i]));
    selectedNew.sort((a, b) => (order.newSort === "type" ? typeOrder(a) - typeOrder(b) : order.newSort === "random-note" ? random(a, true).localeCompare(random(b, true)) || typeOrder(a) - typeOrder(b) : order.newSort === "random" ? random(a).localeCompare(random(b)) : 0) || gatherIndex.get(entryKey(a))! - gatherIndex.get(entryKey(b))!);
    const intra = selectedDue.filter((e) => isLearning(e) && localDayKey(new Date(e.item.schedule.last_review ?? 0)) === localDayKey(now));
    const inter = selectedDue.filter((e) => isLearning(e) && !intra.includes(e));
    const review = selectedDue.filter((e) => !isLearning(e));
    result.push(...intra, ...combine(selectedNew, combine(inter, review, order.interdayOrder ?? "before"), order.newOrder ?? "after"));
    if (extra) result.push(...entries.filter((e) => e.group.id === group.id && !e.isNew && !isDueSchedule(e.item.schedule, now)).sort(byDue));
  }
  return result;
}
function combine(a: QueueEntry[], b: QueueEntry[], order: "before" | "mixed" | "after"): QueueEntry[] {
  if (order === "before") return [...a, ...b]; if (order === "after") return [...b, ...a];
  const out: QueueEntry[] = []; for (let i = 0; i < Math.max(a.length, b.length); i++) { if (b[i]) out.push(b[i]); if (a[i]) out.push(a[i]); } return out;
}
export function getQueueCounts(records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings,
  mode: ReviewMode, now = new Date(), groupId?: string, tagPath?: string, prepared?: DailyQueuePreparation): QueueCounts {
  const queue = buildDailyQueue(records, history, settings, mode, now, false, groupId, tagPath, localDayKey(now), prepared);
  const scoped = records.filter((r) => { const g = resolveGroup(r.tags, groupsFor(settings, mode), r.sourcePath); return g && (!groupId || g.id === groupId) && tagsMatch(r.tags, tagPath); });
  const items = scoped.flatMap((r) => mode === "note" ? [r.note] : Object.values(r.cards));
  return { due: queue.filter((e) => !e.isNew).length, learning: queue.filter(isLearning).length, review: queue.filter((e) => !e.isNew && !isLearning(e)).length,
    new: queue.filter((e) => e.isNew).length, suspended: items.filter((i) => i.status === "suspended").length,
    pendingChanges: items.filter((i) => i.status === "pending-change").length, warnings: scoped.reduce((n, r) => n + r.warnings.length, 0) };
}
function entryKey(e: QueueEntry): string { return itemKey(e.sourceId, e.item.id); }
