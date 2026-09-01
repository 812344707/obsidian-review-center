import { describe, expect, it } from "vitest";
import { createSchedule } from "../src/scheduler";
import { buildDailyQueue } from "../src/queue";
import type {
  HistoryEvent,
  ReviewCenterSettings,
  ReviewItem,
  SourceRecord,
} from "../src/types";

const settings: ReviewCenterSettings = {
  watchedFolders: ["资料"],
  excludedFolders: [],
  reviewHeading: "复习",
  reviewHeadingLevel: 2,
  dataFolder: "复习中心数据",
  noteNewLimit: 1,
  noteReviewLimit: 1,
  cardNewLimit: 1,
  cardReviewLimit: 1,
  noteRetention: 0.85,
  cardRetention: 0.9,
  autoOpenDashboard: false,
};

function makeItem(id: string, introducedAt: string, due: string, reps: number): ReviewItem {
  const schedule = createSchedule(new Date(introducedAt));
  schedule.due = due;
  schedule.reps = reps;
  schedule.state = reps === 0 ? 0 : 2;
  return {
    id,
    kind: "qa",
    revision: 1,
    introducedAt,
    acceptedHash: id,
    content: {
      question: id,
      answer: id,
      raw: id,
      sourceStartLine: 1,
      sourceEndLine: 1,
    },
    schedule,
    status: "active",
  };
}

function makeRecord(reviewId: string, cards: ReviewItem[]): SourceRecord {
  const created = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    reviewId,
    sourcePath: `资料/${reviewId}.md`,
    sourceTitle: reviewId,
    sourceCreatedAt: created,
    updatedAt: created,
    tags: [],
    sourceStatus: "active",
    warnings: [],
    note: makeItem("note", created, created, 1),
    cards: Object.fromEntries(cards.map((card) => [card.id, card])),
    tombstones: {},
  };
}

describe("buildDailyQueue", () => {
  it("takes overdue items first and limits distinct first reviews", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const records = [
      makeRecord("a", [makeItem("due-old", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", 2)]),
      makeRecord("b", [makeItem("due-newer", "2026-07-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z", 2)]),
      makeRecord("c", [makeItem("new", "2026-07-03T00:00:00.000Z", now.toISOString(), 0)]),
    ];

    const queue = buildDailyQueue(records, [], settings, "card", now);
    expect(queue.map((entry) => entry.item.id)).toEqual(["due-old", "new"]);
  });

  it("does not make an Again repeat consume another daily slot", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const repeated = makeItem("repeat", "2026-07-01T00:00:00.000Z", "2026-09-01T07:59:00.000Z", 2);
    const other = makeItem("other", "2026-07-02T00:00:00.000Z", "2026-08-01T00:00:00.000Z", 2);
    const records = [makeRecord("a", [repeated]), makeRecord("b", [other])];
    const history: HistoryEvent[] = [
      {
        schemaVersion: 1,
        eventId: "e1",
        sessionId: "s1",
        deviceId: "d1",
        sourceId: "a",
        itemId: "repeat",
        action: "review",
        occurredAt: now.toISOString(),
        baseRevision: 1,
        nextRevision: 2,
        rating: 1,
        after: repeated,
      },
    ];

    const queue = buildDailyQueue(records, history, settings, "card", now);
    expect(queue.map((entry) => entry.item.id)).toEqual(["repeat", "other"]);
  });

  it("includes future scheduled items only during extra study", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const future = makeItem(
      "future",
      "2026-07-01T00:00:00.000Z",
      "2026-09-10T08:00:00.000Z",
      2,
    );
    const records = [makeRecord("a", [future])];

    expect(buildDailyQueue(records, [], settings, "card", now)).toHaveLength(0);
    expect(buildDailyQueue(records, [], settings, "card", now, true)[0].item.id).toBe("future");
  });
});
