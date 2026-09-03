import type { HistoryEvent, ReviewMode } from "./types";
import { itemKey, localDayKey } from "./utils";

export function eventMode(event: HistoryEvent): ReviewMode {
  return event.mode ?? (event.after?.kind === "note" || event.itemId === "note" ? "note" : "card");
}

/** Undo removes the original review, including when undo happens on another day. */
export function effectiveReviews(history: HistoryEvent[]): HistoryEvent[] {
  const unique = new Map<string, HistoryEvent>();
  for (const event of history) {
    if (event.eventId && Number.isFinite(new Date(event.occurredAt).getTime())) unique.set(event.eventId, event);
  }
  const events = [...unique.values()].sort((a, b) =>
    new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime() || a.eventId.localeCompare(b.eventId));
  const reviews = events.filter((event) => event.action === "review" && [1, 2, 3, 4].includes(event.rating ?? 0));
  const removed = new Set<string>();
  const byRevision = new Map<string, HistoryEvent>();
  for (const review of reviews) {
    byRevision.set(`${itemKey(review.sourceId, review.itemId)}::${review.nextRevision}`, review);
  }
  for (const undo of events.filter((event) => event.action === "undo")) {
    const target = undo.undoOf ?? byRevision.get(`${itemKey(undo.sourceId, undo.itemId)}::${undo.baseRevision}`)?.eventId;
    if (target) removed.add(target);
  }
  return reviews.filter((event) => !removed.has(event.eventId));
}

export interface HeatmapDay { date: string; count: number; level: number }

export function heatmapDays(history: HistoryEvent[], mode: ReviewMode, now = new Date()): HeatmapDay[] {
  const counts = new Map<string, number>();
  for (const event of effectiveReviews(history)) {
    if (eventMode(event) !== mode) continue;
    const key = localDayKey(new Date(event.occurredAt));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  date.setDate(date.getDate() - 364);
  const days: HeatmapDay[] = [];
  for (let index = 0; index < 365; index += 1) {
    const key = localDayKey(date);
    const count = counts.get(key) ?? 0;
    const level = count === 0 ? 0 : count <= 5 ? 1 : count <= 10 ? 2 : count <= 20 ? 3 : 4;
    days.push({ date: key, count, level });
    date.setDate(date.getDate() + 1);
  }
  return days;
}
