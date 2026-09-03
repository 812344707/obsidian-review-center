import { createSchedule } from "../src/scheduler";
import { normalizeSettings } from "../src/config";
import type { HistoryEvent, ReviewItem, ReviewMode, SourceRecord } from "../src/types";

export const today = new Date(2026, 8, 3, 10, 0, 0);
export function fixtureSettings() {
  const settings = normalizeSettings(null);
  settings.noteGroups[0].tags = ["note"];
  settings.cardGroups[0].tags = ["card"];
  return settings;
}
export function fixtureItem(id = "rv-one:qa", fresh = true, due = today): ReviewItem {
  return { id, kind: id === "note" ? "note" : "qa", blockId: id === "note" ? undefined : id.split(":")[0], revision: 1,
    introducedAt: new Date(2026, 7, 1).toISOString(), acceptedHash: "old",
    content: { question: "问题", answer: "答案", raw: "问:: 问题\n答:: 答案", sourceStartLine: 2, sourceEndLine: 3 },
    schedule: { ...createSchedule(due), ...(fresh ? {} : { reps: 4, state: 2, stability: 12, difficulty: 5, last_review: new Date(2026, 8, 1).toISOString() }) }, status: "active" };
}
export function fixtureRecord(id = "source", tags = ["#note", "#card"], card = fixtureItem()): SourceRecord {
  return { schemaVersion: 1, reviewId: id, sourcePath: `资料/${id}.md`, sourceTitle: id,
    sourceCreatedAt: card.introducedAt, updatedAt: today.toISOString(), tags, sourceStatus: "active", warnings: [],
    note: fixtureItem("note"), cards: { [card.id]: card }, tombstones: {} };
}
export function reviewEvent(id: string, sourceId = "source", mode: ReviewMode = "card", date = today, baseRevision = 1): HistoryEvent {
  const after = fixtureItem(mode === "note" ? "note" : "rv-one:qa");
  after.schedule.reps = 1;
  after.revision = baseRevision + 1;
  return { schemaVersion: 1, eventId: id, sessionId: "session", deviceId: "desktop", sourceId, itemId: after.id,
    action: "review", occurredAt: date.toISOString(), baseRevision, nextRevision: baseRevision + 1, rating: 3, after, mode,
    groupId: `default-${mode}`, wasNew: true };
}
