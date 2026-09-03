import { describe, expect, it } from "vitest";
import { effectiveReviews, heatmapDays } from "../src/activity";
import { localDayKey } from "../src/utils";
import { reviewEvent, today } from "./fixtures";

describe("review activity", () => {
  it("counts repeat ratings separately, deduplicates sync copies, and separates notes from cards", () => {
    const first = reviewEvent("one");
    const repeat = { ...reviewEvent("two", "source", "card", today, 2), wasNew: false };
    const note = reviewEvent("three", "source", "note");
    const events = [first, first, repeat, note];
    expect(heatmapDays(events, "card", today).at(-1)?.count).toBe(2);
    expect(heatmapDays(events, "note", today).at(-1)?.count).toBe(1);
    expect(heatmapDays(events, "card", today)).toHaveLength(365);
  });
  it("undo on the next day deducts the original day, not the undo day", () => {
    const first = reviewEvent("first");
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const undo = { ...reviewEvent("undo", "source", "card", tomorrow, 2), action: "undo" as const, undoOf: "first" };
    const days = heatmapDays([undo, first], "card", tomorrow);
    expect(days.at(-2)?.date).toBe(localDayKey(today));
    expect(days.at(-2)?.count).toBe(0);
    expect(days.at(-1)?.count).toBe(0);
  });
  it("understands v1 undo revisions and retains activity without source records", () => {
    const first = reviewEvent("old"); delete first.mode; delete first.groupId; delete first.wasNew;
    const undo = { ...reviewEvent("old-undo", "source", "card", today, 2), action: "undo" as const };
    expect(effectiveReviews([first, undo])).toEqual([]);
    expect(heatmapDays([first], "card", today).at(-1)?.count).toBe(1);
    expect(heatmapDays([{ ...first, occurredAt: "invalid" }], "card", today).at(-1)?.count).toBe(0);
  });
});
