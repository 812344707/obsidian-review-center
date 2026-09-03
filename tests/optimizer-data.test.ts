import { describe, expect, it } from "vitest";
import { buildOptimizerInput, learningHistory, parseHistoryFilter } from "../src/optimizer-data";
import { fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";

describe("optimizer input fidelity", () => {
  it("parses supported quoted filters and rejects unknown expressions", () => {
    expect(parseHistoryFilter('preset:"a b" tag:#card path:"资料/甲" -is:suspended')).toHaveLength(4);
    expect(() => parseHistoryFilter("preset:x nonsense")).toThrow("无法识别");
    expect(() => parseHistoryFilter("is:new")).toThrow("仅支持");
  });
  it("removes duplicate, undone and pre-reset reviews", () => {
    const first = reviewEvent("first"), next = { ...reviewEvent("next", "source", "card", today, 2), wasNew: false };
    const undo = { ...next, eventId: "undo", action: "undo" as const, undoOf: "next" };
    expect(learningHistory([first, first, next, undo], "source", first.itemId).map((e) => e.eventId)).toEqual(["first"]);
    const reset = { ...next, eventId: "reset", action: "reset" as const, nextRevision: 5 };
    expect(learningHistory([first, reset], "source", first.itemId)).toEqual([]);
  });
  it("requires an initial learning event and computes calendar days across midnight", () => {
    const s = fixtureSettings(), preset = s.presets!.find((p) => p.mode === "card")!;
    const first = reviewEvent("first", "source", "card", new Date(2026, 8, 3, 23, 59));
    const second = { ...reviewEvent("second", "source", "card", new Date(2026, 8, 4, 0, 1), 2), wasNew: false, durationMs: 5000 };
    const data = buildOptimizerInput([fixtureRecord()], [first, second], s, preset, "optimize");
    expect(data.samples.at(-1)?.reviews.map((r) => r.delta_t)).toEqual([0, 1]); expect(data.logs.at(-1)?.duration).toBe(5000);
    expect(buildOptimizerInput([fixtureRecord()], [second], s, preset, "optimize").samples).toEqual([]);
  });
  it("restricts by current preset, path and tag, and treats missing time as missing", () => {
    const s = fixtureSettings(), preset = s.presets!.find((p) => p.mode === "card")!;
    preset.parameters.historyFilter = 'tag:card path:"资料/source" -is:suspended';
    const record = fixtureRecord();
    expect(buildOptimizerInput([record], [reviewEvent("first")], s, preset, "retention").logs[0].duration).toBe(0);
    record.cards["rv-one:qa"].status = "suspended";
    expect(buildOptimizerInput([record], [reviewEvent("first")], s, preset, "retention").deck_size).toBe(0);
  });
});
