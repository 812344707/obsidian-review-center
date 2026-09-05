import type { HistoryAction, HistoryEvent, ReviewItem, SourceRecord } from "./types";
import { cloneValue, createId } from "./utils";

export function createHistoryEvent(options: {
  sessionId: string;
  deviceId: string;
  sourceId: string;
  itemId: string;
  action: HistoryAction;
  baseRevision: number;
  after: ReviewItem | null;
  rating?: number;
  now?: Date;
}): HistoryEvent {
  const now = options.now ?? new Date();
  return {
    schemaVersion: 1,
    eventId: createId("event"),
    sessionId: options.sessionId,
    deviceId: options.deviceId,
    sourceId: options.sourceId,
    itemId: options.itemId,
    action: options.action,
    occurredAt: now.toISOString(),
    baseRevision: options.baseRevision,
    nextRevision: options.after?.revision ?? options.baseRevision + 1,
    ...(options.rating === undefined ? {} : { rating: options.rating }),
    after: options.after ? cloneValue(options.after) : null,
  };
}

export function reconcileRecordsWithHistory(
  records: SourceRecord[],
  history: HistoryEvent[],
): { records: SourceRecord[]; conflicts: number } {
  const eventsBySource = new Map<string, HistoryEvent[]>();
  for (const event of history) {
    const events = eventsBySource.get(event.sourceId) ?? [];
    events.push(event);
    eventsBySource.set(event.sourceId, events);
  }

  let conflicts = 0;
  for (const record of records) {
    const sourceEvents = eventsBySource.get(record.reviewId) ?? [];
    const itemIds = new Set<string>([
      "note",
      ...Object.keys(record.cards),
      ...sourceEvents.map((event) => event.itemId),
    ]);
    for (const itemId of itemIds) {
      const fallback = itemId === "note" ? record.note : record.cards[itemId];
      const resolved = resolveItemHistory(
        fallback,
        sourceEvents.filter((event) => event.itemId === itemId),
      );
      conflicts += resolved.conflicts;
      if (itemId === "note") {
        if (resolved.item) record.note = resolved.item;
      } else if (resolved.item) {
        record.cards[itemId] = resolved.item;
        delete record.tombstones[itemId];
      } else {
        delete record.cards[itemId];
        if (resolved.revision > 0) record.tombstones[itemId] = resolved.revision;
      }
    }
    record.warnings = record.warnings.filter((warning) => !warning.startsWith("同步冲突："));
    // A deterministic winner has already been applied above. The returned
    // conflict count remains available for diagnostics, without creating a
    // user-facing task for an event that needs no further action.
  }
  return { records, conflicts };
}

export function resolveItemHistory(
  fallback: ReviewItem | undefined,
  events: HistoryEvent[],
): { item: ReviewItem | null; revision: number; conflicts: number } {
  if (events.length === 0) {
    return { item: fallback ?? null, revision: fallback?.revision ?? 0, conflicts: 0 };
  }
  const groups = groupByBaseRevision(events);
  let revision = groups.has(0) ? 0 : (fallback?.revision ?? 0);
  let item: ReviewItem | null = groups.has(0) ? null : (fallback ?? null);
  let conflicts = 0;
  const visited = new Set<number>();

  while (groups.has(revision) && !visited.has(revision)) {
    visited.add(revision);
    const candidates = groups.get(revision) ?? [];
    if (candidates.length > 1) conflicts += 1;
    const chosen = [...candidates].sort(compareEventWinner).at(-1);
    if (!chosen) break;
    item = chosen.after ? cloneValue(chosen.after) : null;
    revision = chosen.nextRevision;
  }
  // Sync can deliver the source snapshot before the corresponding history file.
  // An incomplete older event chain must never roll that progress backwards.
  if (fallback && fallback.revision > revision) {
    return { item: fallback, revision: fallback.revision, conflicts };
  }
  return { item, revision, conflicts };
}

function groupByBaseRevision(events: HistoryEvent[]): Map<number, HistoryEvent[]> {
  const result = new Map<number, HistoryEvent[]>();
  for (const event of events) {
    const group = result.get(event.baseRevision) ?? [];
    group.push(event);
    result.set(event.baseRevision, group);
  }
  return result;
}

function compareEventWinner(left: HistoryEvent, right: HistoryEvent): number {
  return (
    new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime() ||
    left.eventId.localeCompare(right.eventId)
  );
}
