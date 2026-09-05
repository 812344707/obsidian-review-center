import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (value: string) => value, getAllTags: () => [] }));
import { ReviewService } from "../src/service";
import type { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import type { HistoryEvent, ReviewSession } from "../src/types";
import { fixtureRecord, fixtureSettings, today, fixtureVerifier } from "./fixtures";
import { effectiveReviews } from "../src/activity";

function harness() {
  const settings = fixtureSettings();
  settings.cardGroups[0].parameters.newLimit = 1;
  settings.cardGroups[0].parameters.learningSteps = ["2m", "15m"];
  const records = [fixtureRecord("a"), fixtureRecord("b")];
  const history: HistoryEvent[] = [];
  let session: ReviewSession | null = null;
  const store = { sessionId: "test", deviceId: "desktop", appendHistory: vi.fn(async (events: HistoryEvent[]) => { history.push(...structuredClone(events)); }),
    saveRecord: vi.fn(async () => undefined) };
  const scanner = { ...fixtureVerifier(() => history), scan: async () => ({ records: structuredClone(records), history: structuredClone(history), conflicts: 0 }) };
  const make = () => new ReviewService(scanner as VaultScanner, store as unknown as ReviewStore, () => settings, "0.2.0", (value) => { session = value; });
  const service = make(); service.records = records;
  return { service, records, history, store, settings, make, session: () => session };
}

describe("group review sessions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(today); });
  afterEach(() => { vi.useRealTimers(); });
  it("uses the group parameters, blocks duplicate taps and retains daily quota after reload", async () => {
    const h = harness(); const entry = h.service.startSession("card")!;
    const preview = h.service.preview(entry);
    await Promise.all([h.service.gradeCurrent(3), h.service.gradeCurrent(3)]);
    expect(h.history).toHaveLength(1);
    expect(h.history[0]).toMatchObject({ mode: "card", groupId: "default-card", wasNew: true });
    expect(h.records[0].cards[entry.item.id].schedule).toEqual(preview[3].card);
    expect(h.service.currentEntry()).toBeNull();
    const reloaded = h.make(); await reloaded.refresh(); reloaded.restoreLocalSession(h.session());
    expect(reloaded.startSession("card")).toBeNull();
    vi.advanceTimersByTime(15 * 60_000);
    expect(reloaded.requeueDue()).toBe(true);
    expect(reloaded.currentEntry()?.sourceId).toBe("a");
    expect(reloaded.session?.entryKeys.filter((key) => key.startsWith("b::"))).toHaveLength(0);
  });
  it("applies new parameters on the next score without rewriting an existing schedule", async () => {
    const h = harness(); const entry = h.service.startSession("card")!;
    const schedule = structuredClone(entry.item.schedule);
    h.settings.cardGroups[0].parameters.learningSteps = ["3m"];
    expect(entry.item.schedule).toEqual(schedule);
    expect(h.service.preview(h.service.currentEntry()!)[1].interval).toBe("3 分钟");
    await h.service.gradeCurrent(1);
    expect(new Date(h.records[0].cards[entry.item.id].schedule.due).getTime() - today.getTime()).toBe(180000);
    await h.service.undoLast();
    expect(h.service.currentEntry()?.item.schedule).toEqual(schedule);
    expect(h.history[1].undoOf).toBe(h.history[0].eventId);
    expect(effectiveReviews(h.history)).toHaveLength(0);
  });
  it("honors changed limits and removed groups during a session", () => {
    const h = harness(); h.service.startSession("card");
    h.settings.cardGroups[0].parameters.newLimit = 0;
    expect(h.service.currentEntry()).toBeNull();
    h.settings.cardGroups[0].parameters.newLimit = 1;
    h.service.startSession("card"); h.settings.cardGroups = [];
    expect(h.service.currentEntry()).toBeNull();
  });
  it("does not consume a restored session before the initial scan completes", async () => {
    const h = harness(); h.service.startSession("note", true);
    const saved = structuredClone(h.session())!;
    const reloaded = h.make(); reloaded.restoreLocalSession(saved);
    expect(reloaded.currentEntry()).toBeNull();
    expect(reloaded.session?.currentIndex).toBe(0);
    expect(reloaded.requeueDue()).toBe(false);
    await reloaded.refresh();
    expect(reloaded.currentEntry()?.sourceId).toBe("a");
    expect(reloaded.session?.currentIndex).toBe(0);
  });

});
