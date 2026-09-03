import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (v: string) => v, getAllTags: () => [] }));
import { ReviewService } from "../src/service";
import type { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import type { HistoryEvent, ReviewSession, UndoEntry } from "../src/types";
import { fixtureRecord, fixtureSettings, today } from "./fixtures";

function harness() {
  const settings = fixtureSettings();
  settings.cardGroups[0].parameters.newLimit = 10;
  settings.cardGroups[0].parameters.newSort = "random";
  const records = [fixtureRecord("a", ["card/a", "note"]), fixtureRecord("b", ["card/a", "note"]), fixtureRecord("c", ["card/b", "note"])];
  const history: HistoryEvent[] = [];
  let saved: { session: ReviewSession | null; undo: UndoEntry[] } = { session: null, undo: [] };
  const store = { sessionId: "s", deviceId: "d", appendHistory: vi.fn(async (events: HistoryEvent[]) => { history.push(...structuredClone(events)); }), saveRecord: vi.fn() };
  const scanner = { scan: async () => ({ records: structuredClone(records), history: structuredClone(history), conflicts: 0 }) };
  const make = () => new ReviewService(scanner as VaultScanner, store as unknown as ReviewStore, () => settings, "0.4.2", (session, undo) => { saved = { session, undo }; });
  const service = make(); service.records = records;
  return { service, records, history, settings, make, saved: () => structuredClone(saved) };
}

describe("one start button", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(today); });
  afterEach(() => vi.useRealTimers());
  it("resumes the same scope preserving order, answer, position and undo after a refresh", async () => {
    const h = harness();
    h.service.startOrResumeSession("card", false, "default-card", "card/a");
    const first = h.service.currentEntry()!;
    const before = structuredClone(first.item.schedule);
    await h.service.gradeCurrent(3);
    h.service.setAnswerVisible(true); h.service.setTimingActive(false);
    const session = structuredClone(h.service.session)!;
    await h.service.refresh();
    expect(h.service.startOrResumeSession("card", false, "default-card", "card/a")).not.toBeNull();
    expect(h.service.session).toMatchObject({ id: session.id, entryKeys: session.entryKeys, currentIndex: session.currentIndex, answerVisible: true, orderSeed: session.orderSeed });
    expect(h.service.canUndo()).toBe(true);
    await h.service.undoLast();
    expect(h.service.currentEntry()?.sourceId).toBe(first.sourceId);
    expect(h.service.currentEntry()?.item.schedule).toEqual(before);
  });
  it("restores the same queue and undo on restart and never consumes it before scanning", async () => {
    const h = harness(); h.service.startOrResumeSession("card", false, "default-card");
    const first = h.service.currentEntry()!;
    await h.service.gradeCurrent(3); const saved = h.saved();
    const restarted = h.make(); restarted.restoreLocalSession(saved.session, saved.undo);
    expect(restarted.startOrResumeSession("card", false, "default-card")).toBeNull();
    expect(restarted.session?.currentIndex).toBe(saved.session!.currentIndex);
    await restarted.refresh(); restarted.startOrResumeSession("card", false, "default-card");
    expect(restarted.session?.id).toBe(saved.session!.id);
    expect(restarted.session?.entryKeys).toEqual(saved.session!.entryKeys);
    await restarted.undoLast(); expect(restarted.currentEntry()?.sourceId).toBe(first.sourceId);
  });
  it("does not offer a stale restored undo after the reviewed item changed", async () => {
    const h = harness(); h.service.startOrResumeSession("card", false, "default-card"); await h.service.gradeCurrent(3);
    const saved = h.saved(), restarted = h.make(); restarted.restoreLocalSession(saved.session, saved.undo); await restarted.refresh();
    const record = restarted.records.find((entry) => entry.reviewId === saved.undo[0].sourceId)!;
    record.cards[saved.undo[0].itemId].revision += 1;
    expect(restarted.canUndo()).toBe(false);
  });
  it("persists only the most recent undo snapshot", async () => {
    const h = harness(); h.service.startOrResumeSession("card", false, "default-card");
    await h.service.gradeCurrent(3); await h.service.gradeCurrent(3);
    expect(h.saved().undo).toHaveLength(1);
    expect(h.saved().undo[0].itemId).toBe(h.service.session!.entryKeys[h.service.session!.currentIndex - 1].split("::")[1]);
  });
  it("starts a new session for another branch or mode without clearing history or quotas", async () => {
    const h = harness(); h.settings.cardGroups[0].parameters.newLimit = 1; h.settings.cardGroups[0].parameters.limitsFromTop = true;
    h.service.startOrResumeSession("card", false, "default-card", "card/a");
    await h.service.gradeCurrent(3);
    const id = h.service.session!.id, history = structuredClone(h.history);
    expect(h.service.startOrResumeSession("card", false, "default-card", "card/b")).toBeNull();
    expect(h.service.session!.id).not.toBe(id);
    expect(h.service.session!.tagPath).toBe("card/b");
    expect(h.history).toEqual(history);
    expect(h.service.counts("card").new).toBe(0);
    h.service.startOrResumeSession("note", false, "default-note");
    expect(h.service.session!.mode).toBe("note"); expect(h.history).toEqual(history);
  });
  it("skips suspended, future and newly excluded items while retaining the valid remaining order", async () => {
    const h = harness(); h.service.startOrResumeSession("card", false, "default-card");
    const session = structuredClone(h.service.session)!;
    const first = h.records.find((r) => session.entryKeys[0].startsWith(r.reviewId + "::"))!;
    Object.values(first.cards)[0].status = "suspended";
    const second = h.records.find((r) => session.entryKeys[1].startsWith(r.reviewId + "::"))!;
    second.tags = ["cardinal"];
    await h.service.refresh(); const entry = h.service.startOrResumeSession("card", false, "default-card");
    expect(entry?.sourceId).toBe(session.entryKeys[2].split("::")[0]);
    expect(h.service.session!.id).toBe(session.id);
    entry!.item.schedule.reps = 1; entry!.item.schedule.due = new Date(today.getTime() + 86400000).toISOString();
    expect(h.service.startOrResumeSession("card", false, "default-card")).toBeNull();
  });
  it("requeues a newly due learning item once at the end without resetting a waiting session", async () => {
    const h = harness(); h.service.startOrResumeSession("card", false, "default-card");
    const first = h.service.currentEntry()!; await h.service.gradeCurrent(1);
    const session = structuredClone(h.service.session)!;
    vi.advanceTimersByTime(60000);
    h.service.startOrResumeSession("card", false, "default-card");
    expect(h.service.session!.id).toBe(session.id);
    expect(h.service.session!.entryKeys.slice(0, session.entryKeys.length)).toEqual(session.entryKeys);
    expect(h.service.session!.entryKeys.at(-1)).toBe(first.sourceId + "::" + first.item.id);
    const length = h.service.session!.entryKeys.length;
    h.service.startOrResumeSession("card", false, "default-card");
    expect(h.service.session!.entryKeys).toHaveLength(length);
  });
});
