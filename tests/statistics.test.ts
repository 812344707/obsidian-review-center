import { describe, expect, it } from "vitest";
import { activityDuration, buildStatistics, calendarDate } from "../src/statistics";
import { fixtureItem, fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";
import { localDayKey } from "../src/utils";
import type { HistoryEvent, ReviewItem } from "../src/types";

const settings = fixtureSettings();
function oldReview(id: string, source = id, at = today, rating = 3): HistoryEvent {
  const event = reviewEvent(id, source, "card", at, 4);
  event.wasNew = false; event.rating = rating;
  event.after!.schedule.reps = 5;
  event.beforeSchedule = { ...fixtureItem("card", false).schedule, last_review: new Date(at.getTime() - 86400000 * 3).toISOString() };
  return event;
}
function stats(history: HistoryEvent[], now = today) { return buildStatistics([], history, settings, { mode: "card" }, now); }

describe("practical review statistics", () => {
  it("separates newly learned content from old content, while repeats only add attempts and time", () => {
    const first = reviewEvent("new"); first.durationMs = 15000;
    const repeat = oldReview("repeat", "source"); repeat.durationMs = 30000;
    const older = oldReview("old"); older.durationMs = 45000;
    const note = reviewEvent("note", "source", "note");
    const result = stats([older, first, repeat, note, first]);
    expect(result.today).toMatchObject({ fresh: 1, reviewed: 1, attempts: 3, durationMs: 90000, timed: 3 });
    expect(result.retention[1]).toMatchObject({ passed: 1, failed: 0 });
    expect(buildStatistics([], [first, note], settings, { mode: "note" }, today).today.fresh).toBe(1);
  });

  it("removes cross-day undo globally even when the undo lacks scope metadata", () => {
    const event = oldReview("first"); event.sourceTags = ["#card/child"];
    const tomorrow = calendarDate(today, 1);
    const undo = { ...reviewEvent("undo", "first", "card", tomorrow, event.nextRevision), action: "undo" as const, undoOf: event.eventId };
    delete undo.groupId; delete undo.mode;
    const result = buildStatistics([], [event, undo], settings, { mode: "card", groupId: "default-card", tagPath: "card/child" }, tomorrow);
    expect(result.activity.at(-2)?.attempts).toBe(0);
    expect(result.retention[1].passed).toBe(0);
  });

  it("never treats missing or invalid duration as zero measured time", () => {
    const unrecorded = oldReview("old");
    expect(activityDuration(stats([unrecorded]).today)).toBe("未记录");
    const measured = oldReview("measured"); measured.durationMs = 1500;
    const invalid = oldReview("invalid"); invalid.durationMs = -10;
    const enormous = oldReview("enormous"); enormous.durationMs = 900000;
    const result = stats([unrecorded, measured, invalid, enormous]);
    expect(result.today).toMatchObject({ timed: 2, attempts: 4, durationMs: 301500 });
    expect(activityDuration(stats([]).today)).toBe("0 秒");
    measured.durationMs = 0;
    expect(stats([measured]).today.timed).toBe(1);
  });

  it("reports genuinely unclassifiable old activity without fabricating new/review counts", () => {
    const event = oldReview("unknown"); delete event.wasNew; delete event.beforeSchedule; event.after = null;
    expect(stats([event]).today).toMatchObject({ fresh: 0, reviewed: 0, unclassified: 1, attempts: 1 });
    expect(stats([event]).retention[1]).toMatchObject({ unknown: 1, passed: 0, failed: 0 });
  });

  it("retains historical activity after a source is deleted, and uses recorded group/tag boundaries", () => {
    const yes = oldReview("yes"); yes.sourceTags = ["#card/child/deep", "#card"];
    const no = oldReview("no"); no.sourceTags = ["#card/children"];
    const other = oldReview("other"); other.groupId = "another"; other.sourceTags = ["#card/child"];
    const result = buildStatistics([], [yes, no, other], settings, { mode: "card", groupId: "default-card", tagPath: "card/child" }, today);
    expect(result.today.reviewed).toBe(1);
    expect(stats([yes, no, other]).today.reviewed).toBe(3);
  });

  it("uses current membership only for legacy events without saved group/tag metadata", () => {
    const legacy = oldReview("legacy"); delete legacy.groupId;
    const record = fixtureRecord("legacy", ["card/child"]);
    expect(buildStatistics([record], [legacy], settings, { mode: "card", groupId: "default-card", tagPath: "card/child" }, today).today.reviewed).toBe(1);
  });

  it("measures delayed first recall and excludes short repeats and new learning", () => {
    const failed = oldReview("a-failed", "a", today, 1);
    const repeat = oldReview("z-repeat", "a", today, 4);
    const hard = oldReview("hard", "hard", today, 2);
    const short = oldReview("short"); short.beforeSchedule!.last_review = new Date(today.getTime() - 86399000).toISOString();
    const boundary = oldReview("boundary"); boundary.beforeSchedule!.last_review = new Date(today.getTime() - 86400000).toISOString();
    const result = stats([repeat, failed, hard, short, boundary, reviewEvent("fresh")]);
    expect(result.retention[1]).toMatchObject({ passed: 2, failed: 1, unknown: 0 });
  });

  it("reconstructs a legacy pre-review state only from the matching revision", () => {
    const previous = oldReview("previous", "source", calendarDate(today, -3));
    previous.after!.schedule.last_review = previous.occurredAt;
    const current = oldReview("current", "source");
    delete current.beforeSchedule; current.baseRevision = previous.nextRevision;
    current.nextRevision = current.baseRevision + 1; current.after!.revision = current.nextRevision;
    expect(stats([previous, current]).retention[1].passed).toBe(2);
    current.baseRevision = 99;
    expect(stats([previous, current]).retention[1]).toMatchObject({ passed: 1, unknown: 1 });
  });

  it("does not connect old history across resets or ambiguous predecessor snapshots", () => {
    const previous = oldReview("previous", "source", calendarDate(today, -3));
    previous.after!.schedule.last_review = previous.occurredAt;
    const reset = { ...previous, eventId: "reset", action: "reset" as const, occurredAt: calendarDate(today, -1).toISOString(), after: fixtureItem() };
    reset.after.revision = previous.nextRevision + 1; reset.nextRevision = reset.after.revision; reset.baseRevision = previous.nextRevision;
    const current = oldReview("current", "source"); delete current.beforeSchedule; delete current.wasNew; current.baseRevision = reset.nextRevision;
    expect(stats([previous, reset, current]).retention[1].passed).toBe(1);
    const conflict = { ...previous, eventId: "conflict", after: structuredClone(previous.after) };
    conflict.after!.schedule.last_review = calendarDate(today, -2).toISOString();
    current.baseRevision = previous.nextRevision; current.wasNew = false;
    expect(stats([previous, conflict, current]).retention[1].unknown).toBe(1);
  });

  it("keeps a daily first recall outside a later scope from becoming a second first recall", () => {
    const first = oldReview("a", "source"); first.sourceTags = ["card/old"];
    const second = oldReview("z", "source"); second.sourceTags = ["card/new"];
    const result = buildStatistics([], [first, second], settings, { mode: "card", tagPath: "card/new" }, today);
    expect(result.today.attempts).toBe(1);
    expect(result.retention[1].passed).toBe(0);
  });

  it("uses local date windows, fills inactive days, and excludes future or malformed logs", () => {
    const old = oldReview("old", "old", calendarDate(today, -30));
    const recent = oldReview("recent", "recent", calendarDate(today, -29));
    const future = oldReview("future", "future", new Date(today.getTime() + 1000));
    const invalid = { ...oldReview("invalid"), occurredAt: "invalid" };
    const result = stats([old, recent, future, invalid]);
    expect(result.activity).toHaveLength(365);
    expect(result.today.attempts).toBe(0);
    expect(result.retention[1].passed).toBe(1);
    expect(result.retention[2].passed).toBe(2);
    expect(result.activity.at(-30)?.date).toBe(localDayKey(calendarDate(today, -29)));
  });

  it("does not skip or duplicate local days around daylight-saving changes", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const day = new Date(2026, 2, 9, 10);
      expect([-2, -1, 0, 1].map((offset) => localDayKey(calendarDate(day, offset)))).toEqual(["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
      expect(calendarDate(day, -1).getTime() - calendarDate(day, -2).getTime()).toBe(23 * 3600000);
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });
});

describe("full due workload", () => {
  function record(id: string, offset: number, change?: (item: ReviewItem) => void) {
    const item = fixtureItem(`${id}:qa`, false, calendarDate(today, offset)); change?.(item);
    return fixtureRecord(id, ["card/child", "card/child/deep"], item);
  }
  it("counts full backlog, today including later times, and next 7/30 days without daily caps", () => {
    const records = [record("past", -2), record("past2", -1), record("later-today", 0), record("tomorrow", 1), record("day7", 7), record("day30", 30), record("beyond", 31)];
    const config = fixtureSettings(); config.presets!.forEach((p) => p.parameters.reviewLimit = 1);
    const result = buildStatistics(records, [], config, { mode: "card" }, today);
    expect(result.overdue).toBe(2); expect(result.dueToday).toBe(1);
    expect(result.forecast[0].count).toBe(1);
    expect(result.forecast.slice(0, 7).reduce((n, d) => n + d.count, 0)).toBe(2);
    expect(result.forecast[29].count).toBe(1);
  });

  it("excludes new, inactive and out-of-scope content, defers burial, and deduplicates identities", () => {
    const active = record("active", -1);
    const fresh = record("fresh", -1, (i) => { i.schedule.state = 0; i.schedule.reps = 0; });
    const suspended = record("suspended", -1, (i) => i.status = "suspended");
    const pending = record("pending", -1, (i) => i.status = "pending-change");
    const removed = record("removed", -1, (i) => i.status = "removed");
    const out = record("out", -1); out.sourceStatus = "out-of-scope";
    const buried = record("buried", -1, (i) => i.buriedUntil = localDayKey(calendarDate(today, 1)));
    const expired = record("expired", -1, (i) => i.buriedUntil = localDayKey(today));
    const result = buildStatistics([active, structuredClone(active), fresh, suspended, pending, removed, out, buried, expired], [], settings, { mode: "card", tagPath: "card/child" }, today);
    expect(result.overdue).toBe(2); expect(result.deferred).toBe(1); expect(result.forecast[0].count).toBe(1);
    expect(buildStatistics([active], [], settings, { mode: "card", tagPath: "card/children" }, today).overdue).toBe(0);
  });

  it("does not mutate schedules, history or settings while calculating statistics", () => {
    const records = [record("a", -1)], history = [oldReview("a")];
    const before = JSON.stringify({ records, history, settings });
    buildStatistics(records, history, settings, { mode: "card" }, today);
    expect(JSON.stringify({ records, history, settings })).toBe(before);
    records[0].cards["a:qa"].schedule.due = "invalid";
    expect(buildStatistics(records, history, settings, { mode: "card" }, today).invalidDue).toBe(1);
  });
});
