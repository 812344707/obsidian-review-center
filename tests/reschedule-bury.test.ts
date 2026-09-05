import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (v: string) => v, getAllTags: () => [] }));
import { ReviewService } from "../src/service";
import { planReschedule } from "../src/reschedule";
import { fixtureItem, fixtureRecord, fixtureSettings, reviewEvent, today, fixtureVerifier } from "./fixtures";
import type { ReviewStore } from "../src/storage";
import type { VaultScanner } from "../src/scanner";
import type { HistoryEvent } from "../src/types";

describe("sibling bury and rescheduling", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(today); }); afterEach(() => vi.useRealTimers());
  it("records visible review time and excludes a paused session's time away", async () => {
    const settings = fixtureSettings();
    const store = { sessionId: "s", deviceId: "d", appendHistory: vi.fn(), saveRecord: vi.fn() };
    const service: ReviewService = new ReviewService(fixtureVerifier(() => service.history) as VaultScanner, store as unknown as ReviewStore, () => settings, "0.4", () => {});
    service.records = [fixtureRecord()]; service.startSession("card");
    const before = structuredClone(service.currentEntry()!.item.schedule);
    vi.advanceTimersByTime(2000); service.setTimingActive(false); vi.advanceTimersByTime(600000); service.setTimingActive(true); vi.advanceTimersByTime(3000);
    await service.gradeCurrent(3); expect(service.history.at(-1)?.durationMs).toBe(5000);
    expect(service.history.at(-1)?.beforeSchedule).toEqual(before);
    expect(service.history.at(-1)?.beforeSchedule).not.toBe(service.currentEntry()?.item.schedule);
  });
  it("buries only the same cloze block and undo restores it without changing its schedule", async () => {
    const s = fixtureSettings(); s.cardGroups[0].parameters.buryNew = true;
    const first = fixtureItem("block:cloze:1"), sibling = fixtureItem("block:cloze:2"), other = fixtureItem("other:cloze:1");
    for (const [item, index] of [[first, 1], [sibling, 2], [other, 1]] as const) { item.kind = "cloze"; item.blockId = item.id.split(":")[0]; item.clozeIndex = index; }
    const record = fixtureRecord(); record.cards = Object.fromEntries([first, sibling, other].map((i) => [i.id, i]));
    const history: HistoryEvent[] = [], store = { sessionId: "s", deviceId: "d", appendHistory: vi.fn(async (e) => history.push(...structuredClone(e))), saveRecord: vi.fn() };
    const service: ReviewService = new ReviewService(fixtureVerifier(() => service.history) as VaultScanner, store as unknown as ReviewStore, () => s, "0.4", () => {}); service.records = [record]; service.history = [];
    const before = structuredClone(sibling.schedule); service.startSession("card"); await service.gradeCurrent(3);
    expect(record.cards[sibling.id]).toMatchObject({ buriedUntil: "2026-09-04" }); expect(record.cards[sibling.id].schedule).toEqual(before);
    expect(record.cards[other.id].buriedUntil).toBeUndefined(); expect(history.map((e) => e.action)).toEqual(["review", "bury"]);
    await service.undoLast(); expect(record.cards[sibling.id].buriedUntil).toBeUndefined(); expect(record.cards[sibling.id].schedule).toEqual(before);
  });
  it("marks a leech or suspends it at the configured threshold", async () => {
    for (const action of ["tag", "suspend"] as const) {
      const s = fixtureSettings(); const p = s.cardGroups[0].parameters; p.leechThreshold = 1; p.leechAction = action;
      const record = fixtureRecord("source", ["card"], fixtureItem("rv-one:qa", false)), history: HistoryEvent[] = [], store = { sessionId: "s", deviceId: "d", appendHistory: async (e: HistoryEvent[]) => history.push(...e), saveRecord: vi.fn() };
      const service: ReviewService = new ReviewService(fixtureVerifier(() => service.history) as VaultScanner, store as unknown as ReviewStore, () => s, "0.4", () => {}); service.records = [record]; service.history = [];
      service.startSession("card"); await service.gradeCurrent(1);
      expect(record.cards["rv-one:qa"].leech).toBe(true); expect(record.cards["rv-one:qa"].status).toBe(action === "suspend" ? "suspended" : "active");
    }
  });
  it("plans changed reviewed items, preserves identity/progress and skips missing histories", () => {
    const before = fixtureSettings(), next = structuredClone(before), record = fixtureRecord("source", ["card"], fixtureItem("rv-one:qa", false));
    const first = reviewEvent("first"); first.after!.schedule.state = 1;
    const second = { ...reviewEvent("second", "source", "card", new Date(today.getTime() + 86400000), 2), wasNew: false }; second.after!.schedule.state = 2;
    record.cards["rv-one:qa"].schedule.last_review = second.occurredAt; record.cards["rv-one:qa"].revision = 3;
    next.cardGroups[0].parameters.retention = .95; next.cardGroups[0].parameters.rescheduleOnChange = true;
    const plan = planReschedule([record], [first, second], before, next);
    expect(plan.entries).toHaveLength(1); expect(plan.entries[0].after).toMatchObject({ id: "rv-one:qa", revision: 4, status: "active" }); expect(plan.entries[0].after.schedule.reps).toBe(record.cards["rv-one:qa"].schedule.reps);
    expect(planReschedule([record], [], before, next).skipped[0]).toContain("缺少完整学习历史");
  });
  it("does not plan when the toggle is off or only display settings change", () => {
    const before = fixtureSettings(), next = structuredClone(before); next.cardGroups[0].parameters.newOrder = "mixed";
    expect(planReschedule([fixtureRecord()], [], before, next).entries).toEqual([]);
    next.cardGroups[0].parameters.retention = .99;
    expect(planReschedule([fixtureRecord()], [], before, next).entries).toEqual([]);
  });
});
