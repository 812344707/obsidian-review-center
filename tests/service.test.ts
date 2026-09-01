import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class {},
  getAllTags: () => [],
  normalizePath: (value: string) => value,
}));

import { ReviewService } from "../src/service";
import { createSchedule } from "../src/scheduler";
import type { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import type {
  HistoryEvent,
  ReviewCenterSettings,
  ReviewItem,
  ReviewSession,
  SourceRecord,
} from "../src/types";

const settings: ReviewCenterSettings = {
  watchedFolders: ["资料"],
  excludedFolders: [],
  reviewHeading: "复习",
  reviewHeadingLevel: 2,
  dataFolder: "复习中心数据",
  noteNewLimit: 1,
  noteReviewLimit: 10,
  cardNewLimit: 10,
  cardReviewLimit: 100,
  noteRetention: 0.85,
  cardRetention: 0.9,
  autoOpenDashboard: false,
};

function makeItem(status: ReviewItem["status"] = "active"): ReviewItem {
  return {
    id: "rv-card:qa",
    kind: "qa",
    blockId: "rv-card",
    revision: 1,
    introducedAt: "2026-09-01T00:00:00.000Z",
    acceptedHash: "old",
    content: {
      question: "问题",
      answer: "答案",
      raw: "问:: 问题\n答:: 答案",
      sourceStartLine: 10,
      sourceEndLine: 11,
    },
    schedule: createSchedule(new Date("2026-09-01T00:00:00.000Z")),
    status,
  };
}

function makeRecord(item = makeItem()): SourceRecord {
  return {
    schemaVersion: 1,
    reviewId: "note-source",
    sourcePath: "资料/测试.md",
    sourceTitle: "测试",
    sourceCreatedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    tags: ["#测试"],
    sourceStatus: "active",
    warnings: [],
    note: { ...makeItem(), id: "note", kind: "note" },
    cards: { [item.id]: item },
    tombstones: {},
  };
}

describe("ReviewService session state", () => {
  let record: SourceRecord;
  let events: HistoryEvent[];
  let savedSession: ReviewSession | null;
  let scanner: { scan: ReturnType<typeof vi.fn> };
  let store: {
    sessionId: string;
    deviceId: string;
    appendHistory: ReturnType<typeof vi.fn>;
    saveRecord: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    record = makeRecord();
    events = [];
    savedSession = null;
    scanner = {
      scan: vi.fn(async () => ({ records: [record], history: events, conflicts: 0 })),
    };
    store = {
      sessionId: "session-test",
      deviceId: "device-test",
      appendHistory: vi.fn(async (next: HistoryEvent[]) => {
        events.push(...next);
      }),
      saveRecord: vi.fn(async () => undefined),
    };
  });

  function service(): ReviewService {
    return new ReviewService(
      scanner as unknown as VaultScanner,
      store as unknown as ReviewStore,
      () => settings,
      "0.1.0",
      (session) => {
        savedSession = session;
      },
    );
  }

  it("persists a rating and restores the exact card after undo", async () => {
    const review = service();
    review.records = [record];
    const entry = review.startSession("card");
    expect(entry?.item.id).toBe("rv-card:qa");

    await review.gradeCurrent(3);
    expect(record.cards["rv-card:qa"].revision).toBe(2);
    expect(review.canUndo()).toBe(true);

    const restored = await review.undoLast();
    expect(restored?.item.id).toBe("rv-card:qa");
    expect(record.cards["rv-card:qa"].revision).toBe(3);
    expect(events.map((event) => event.action)).toEqual(["review", "undo"]);
    expect(savedSession?.currentIndex).toBe(0);
  });

  it("keeps a changed current card in the session until the user resolves it", async () => {
    const review = service();
    review.records = [record];
    review.startSession("card");
    record.cards["rv-card:qa"].status = "pending-change";
    record.cards["rv-card:qa"].pendingHash = "new";

    await review.refresh();
    expect(review.currentPendingChange()).toBe(true);
    expect(review.session?.entryKeys).toHaveLength(1);
    expect(review.currentEntry()).toBeNull();

    await review.resolveChanges([
      { sourceId: record.reviewId, itemId: "rv-card:qa", reset: false },
    ]);
    expect(review.currentPendingChange()).toBe(false);
    expect(review.currentEntry()?.item.id).toBe("rv-card:qa");
    expect(record.cards["rv-card:qa"].acceptedHash).toBe("new");
  });
});
