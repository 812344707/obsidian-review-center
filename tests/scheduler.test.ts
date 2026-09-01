import { describe, expect, it } from "vitest";
import { Rating } from "ts-fsrs";
import { applyRating, createSchedule, isNewSchedule, previewSchedule } from "../src/scheduler";
import type { ReviewItem } from "../src/types";

function createItem(now: Date): ReviewItem {
  return {
    id: "card-1",
    kind: "qa",
    revision: 1,
    introducedAt: now.toISOString(),
    acceptedHash: "hash",
    content: {
      question: "问题",
      answer: "答案",
      raw: "问:: 问题\n答:: 答案",
      sourceStartLine: 1,
      sourceEndLine: 2,
    },
    schedule: createSchedule(now),
    status: "active",
  };
}

describe("FSRS scheduler", () => {
  it("previews four grades without mutating the item", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const item = createItem(now);
    const original = JSON.stringify(item);
    const preview = previewSchedule(item, 0.9, now);

    expect(Object.keys(preview)).toEqual(["1", "2", "3", "4"]);
    expect(preview[Rating.Good].interval.length).toBeGreaterThan(0);
    expect(JSON.stringify(item)).toBe(original);
  });

  it("persists the selected result and increments revision", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const item = createItem(now);
    const reviewed = applyRating(item, Rating.Good, 0.9, now);

    expect(reviewed.revision).toBe(2);
    expect(reviewed.schedule.reps).toBeGreaterThan(0);
    expect(isNewSchedule(reviewed.schedule)).toBe(false);
    expect(reviewed.lastReviewedAt).toBe(now.toISOString());
  });
});
