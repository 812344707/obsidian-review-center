import { defaultParameters } from "../src/config";
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
    const preview = previewSchedule(item, defaultParameters("card"), now);

    expect(Object.keys(preview)).toEqual(["1", "2", "3", "4"]);
    expect(preview[Rating.Good].interval.length).toBeGreaterThan(0);
    expect(JSON.stringify(item)).toBe(original);
  });

  it("persists the selected result and increments revision", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const item = createItem(now);
    const reviewed = applyRating(item, Rating.Good, defaultParameters("card"), now);

    expect(reviewed.revision).toBe(2);
    expect(reviewed.schedule.reps).toBeGreaterThan(0);
    expect(isNewSchedule(reviewed.schedule)).toBe(false);
    expect(reviewed.lastReviewedAt).toBe(now.toISOString());
  });
  it("uses group-specific steps, empty steps, retention and maximum interval", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const item = createItem(now);
    const params = { ...defaultParameters("card"), learningSteps: ["3m", "20m"], relearningSteps: ["5m"], maximumInterval: 2 };
    const preview = previewSchedule(item, params, now);
    const again = applyRating(item, Rating.Again, params, now);
    expect(again.schedule.due).toBe(preview[Rating.Again].card.due);
    expect(new Date(again.schedule.due).getTime() - now.getTime()).toBe(180000);
    expect(new Date(preview[Rating.Good].card.due).getTime() - now.getTime()).toBe(1200000);
    const mature = { ...item, schedule: { ...item.schedule, state: 2, reps: 20, stability: 60, difficulty: 5, last_review: "2026-08-01T08:00:00.000Z" } };
    const limited = applyRating(mature, Rating.Easy, params, now);
    expect(limited.schedule.scheduled_days).toBeLessThanOrEqual(2);
    const low = previewSchedule(mature, { ...defaultParameters("card"), retention: 0.7 }, now);
    const high = previewSchedule(mature, { ...defaultParameters("card"), retention: 0.99 }, now);
    expect(new Date(high[Rating.Good].card.due).getTime()).toBeLessThan(new Date(low[Rating.Good].card.due).getTime());
    expect(() => previewSchedule(item, { ...params, learningSteps: [], relearningSteps: [] }, now)).not.toThrow();
  });

  it("keeps interval fuzz stable while the user considers the answer", () => {
    const now = new Date("2026-09-01T08:00:00.000Z");
    const item = createItem(now);
    item.schedule = { ...item.schedule, state: 2, reps: 20, stability: 60, difficulty: 5, last_review: "2026-08-01T08:00:00.000Z" };
    const params = defaultParameters("card");
    const days = new Set(Array.from({ length: 10 }, (_, i) => previewSchedule(item, params, new Date(now.getTime() + i * 1000))[Rating.Good].card.scheduled_days));
    expect(days.size).toBe(1);
    expect(applyRating(item, Rating.Good, params, new Date(now.getTime() + 15000)).schedule.scheduled_days).toBe([...days][0]);
  });

});
