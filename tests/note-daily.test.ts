import { afterEach, describe, expect, it, vi } from "vitest";
import { Rating } from "ts-fsrs";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (value: string) => value, getAllTags: () => [] }));
import { defaultParameters } from "../src/config";
import { applyRating, isDueSchedule, previewSchedule, reviewDueDate, REVIEW_GRADES } from "../src/scheduler";
import { buildDailyQueue, getQueueCounts } from "../src/queue";
import { buildStatistics } from "../src/statistics";
import { ReviewService } from "../src/service";
import { planReschedule } from "../src/reschedule";
import { fixtureItem, fixtureRecord, fixtureSettings, fixtureVerifier, reviewEvent } from "./fixtures";
import type { ReviewStore } from "../src/storage";
import type { VaultScanner } from "../src/scanner";

const evening = new Date(2026, 8, 7, 23, 30);
const tomorrow = new Date(2026, 8, 8);

describe("notes use calendar days while cards retain short-term learning", () => {
  afterEach(() => vi.useRealTimers());

  it.each([0, 1, 2, 3])("schedules every grade in whole days from state %s, including legacy steps", (state) => {
    const item = fixtureItem("note", state === 0, evening);
    item.schedule.state = state;
    const before = structuredClone(item);
    const params = { ...defaultParameters("note"), learningSteps: ["1m", "10m"], relearningSteps: ["10m"] };
    const preview = previewSchedule(item, params, evening);
    for (const grade of REVIEW_GRADES) {
      const after = applyRating(item, grade, params, evening);
      expect(after.schedule).toEqual(preview[grade].card);
      expect(preview[grade].interval).toMatch(/^\d+ 天$/);
      expect(after.schedule.scheduled_days).toBeGreaterThanOrEqual(1);
      expect(after.schedule.scheduled_days).toBeLessThanOrEqual(90);
      expect(new Date(after.schedule.due)).toEqual(new Date(2026, 8, 7 + after.schedule.scheduled_days));
      expect(after.schedule.state).toBe(2);
      expect(after.schedule.learning_steps).toBe(0);
      expect(after.schedule.reps).toBe(item.schedule.reps + 1);
      expect(after).toMatchObject({ id: item.id, acceptedHash: item.acceptedHash, content: item.content });
    }
    expect(item).toEqual(before);
  });

  it.each([new Date(2026, 2, 8, 0, 30), new Date(2026, 10, 1, 0, 30), evening])("makes one day due at the next local midnight (%s)", (now) => {
    const item = fixtureItem("note");
    const after = applyRating(item, Rating.Again, defaultParameters("note"), now);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    expect(new Date(after.schedule.due)).toEqual(midnight);
    expect(isDueSchedule(after.schedule, new Date(midnight.getTime() - 1), "note")).toBe(false);
    expect(isDueSchedule(after.schedule, midnight, "note")).toBe(true);
  });

  it("honors small and long day ceilings in both button preview and saved result", () => {
    const item = fixtureItem("note", false);
    item.schedule.stability = 500;
    for (const maximumInterval of [1, 90]) {
      const params = { ...defaultParameters("note"), maximumInterval };
      const result = applyRating(item, Rating.Easy, params, evening);
      expect(result.schedule.scheduled_days).toBeLessThanOrEqual(maximumInterval);
      expect(result.schedule.scheduled_days).toBeGreaterThanOrEqual(maximumInterval === 1 ? 1 : 30);
      expect(previewSchedule(item, params, evening)[Rating.Easy].interval).toBe(`${result.schedule.scheduled_days} 天`);
    }
  });

  it("uses the calendar-day gap for memory updates but retains the actual review time", () => {
    const item = applyRating(fixtureItem("note"), Rating.Good, defaultParameters("note"), evening);
    const morning = new Date(2026, 8, 8, 8), late = new Date(2026, 8, 8, 23, 59);
    const a = applyRating(item, Rating.Good, defaultParameters("note"), morning);
    const b = applyRating(item, Rating.Good, defaultParameters("note"), late);
    expect(a.schedule.elapsed_days).toBe(1);
    expect(a.schedule.stability).toBe(b.schedule.stability);
    expect(a.schedule.due).toBe(b.schedule.due);
    expect(a.schedule.last_review).toBe(morning.toISOString());
    expect(a.lastReviewedAt).toBe(morning.toISOString());
  });

  it("reveals a legacy note for its entire due date while its card still waits for the exact minute", () => {
    const settings = fixtureSettings(), record = fixtureRecord();
    record.note = fixtureItem("note", false, evening);
    record.cards = { "rv-one:qa": fixtureItem("rv-one:qa", false, evening) };
    const morning = new Date(2026, 8, 7, 8);
    expect(buildDailyQueue([record], [], settings, "note", morning)).toHaveLength(1);
    expect(buildDailyQueue([record], [], settings, "card", morning)).toHaveLength(0);
    const card = applyRating(fixtureItem(), Rating.Again, defaultParameters("card"), evening);
    expect(new Date(card.schedule.due).getTime() - evening.getTime()).toBe(60000);
    expect(previewSchedule(fixtureItem(), defaultParameters("card"), evening)[Rating.Good].interval).toBe("10 分钟");
  });

  it.each([1, 3])("defers a legacy same-day note in state %s consistently in queue, counts and forecast", (state) => {
    const settings = fixtureSettings(), record = fixtureRecord();
    record.note = fixtureItem("note", false, new Date(evening.getTime() + 60000));
    record.note.schedule = { ...record.note.schedule, state, last_review: evening.toISOString(), scheduled_days: 0 };
    const before = JSON.stringify(record);
    const later = new Date(evening.getTime() + 600000);
    expect(buildDailyQueue([record], [], settings, "note", later)).toHaveLength(0);
    expect(reviewDueDate(record.note)).toEqual(tomorrow);
    const statistics = buildStatistics([record], [], settings, { mode: "note" }, later);
    expect(statistics.dueToday).toBe(0);
    expect(statistics.forecast[0]).toMatchObject({ date: "2026-09-08", count: 1 });
    expect(getQueueCounts([record], [], settings, "note", tomorrow)).toMatchObject({ due: 1, review: 1, learning: 0 });
    expect(JSON.stringify(record)).toBe(before);
  });

  it("supports grading, session restore, next-day requeue and undo without changing cards", async () => {
    vi.useFakeTimers(); vi.setSystemTime(evening);
    const settings = fixtureSettings();
    const store = { sessionId: "s", deviceId: "d", appendHistory: vi.fn(), saveRecord: vi.fn() };
    const service: ReviewService = new ReviewService(fixtureVerifier(() => service.history) as VaultScanner, store as unknown as ReviewStore, () => settings, "0.4.5", () => {});
    service.hasLoaded = true; service.records = [fixtureRecord()];
    const cards = JSON.stringify(service.records[0].cards), original = structuredClone(service.records[0].note.schedule);
    service.startSession("note"); await service.gradeCurrent(Rating.Again);
    expect(service.currentEntry()).toBeNull();
    expect(service.nextDue("note")).toEqual(tomorrow);
    service.restoreLocalSession(structuredClone(service.session));
    expect(service.startOrResumeSession("note")).toBeNull();
    vi.setSystemTime(tomorrow);
    expect(service.requeueDue()).toBe(true);
    expect(service.currentEntry()?.item.id).toBe("note");
    expect(service.counts("note")).toMatchObject({ due: 1, review: 1, learning: 0 });
    // A fresh session also supports undoing its day-based score.
    await service.gradeCurrent(Rating.Good);
    await service.undoLast();
    expect(service.currentEntry()?.item.schedule.reps).toBe(1);
    expect(JSON.stringify(service.records[0].cards)).toBe(cards);
    expect(service.history.filter((event) => event.action === "review")[0].beforeSchedule).toEqual(original);
  });

  it("keeps explicitly requested note rescheduling on dates and preserves review history", () => {
    const previous = fixtureSettings(), next = structuredClone(previous), record = fixtureRecord();
    const first = reviewEvent("first", "source", "note", evening);
    first.after = applyRating(record.note, Rating.Easy, previous.noteGroups[0].parameters, evening);
    record.note = structuredClone(first.after);
    next.noteGroups[0].parameters.maximumInterval = 1;
    next.noteGroups[0].parameters.rescheduleOnChange = true;
    const baseline = JSON.stringify({ record, first });
    const plan = planReschedule([record], [first], previous, next);
    expect(plan.entries).toHaveLength(1);
    expect(new Date(plan.entries[0].after.schedule.due)).toEqual(tomorrow);
    expect(plan.entries[0].after.schedule.reps).toBe(record.note.schedule.reps);
    expect(JSON.stringify({ record, first })).toBe(baseline);
  });
});
