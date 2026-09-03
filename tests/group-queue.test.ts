import { describe, expect, it } from "vitest";
import { buildDailyQueue, collectEntries } from "../src/queue";
import { fixtureItem, fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";

describe("independent daily group quotas", () => {
  it("admits notes and cards independently and resolves group before filtering", () => {
    const settings = fixtureSettings();
    settings.cardGroups.push({ ...settings.cardGroups[0], id: "child", tags: ["card/child"] });
    const noteOnly = fixtureRecord("note", ["#note"]);
    const cardOnly = fixtureRecord("card", ["#card/child"]);
    const records = [noteOnly, cardOnly];
    expect(collectEntries(records, "note", settings).map((e) => e.sourceId)).toEqual(["note"]);
    expect(collectEntries(records, "card", settings).map((e) => e.group.id)).toEqual(["child"]);
    expect(buildDailyQueue(records, [], settings, "card", today, false, "default-card")).toEqual([]);
    cardOnly.sourceStatus = "parse-error"; cardOnly.tags.push("#note");
    expect(collectEntries(records, "card", settings)).toHaveLength(0);
    expect(collectEntries(records, "note", settings)).toHaveLength(2);
  });
  it("does not reset new quota on a new session; repeats do not take another slot", () => {
    const settings = fixtureSettings(); settings.cardGroups[0].parameters.newLimit = 1;
    const repeated = fixtureRecord("a", ["#card"], fixtureItem("rv-one:qa", false));
    const fresh = fixtureRecord("b", ["#card"]);
    const event = reviewEvent("first", "a");
    expect(buildDailyQueue([repeated, fresh], [event], settings, "card", today).map((e) => e.sourceId)).toEqual(["a"]);
    expect(buildDailyQueue([repeated, fresh], [event, { ...event, eventId: "repeat", wasNew: false }], settings, "card", today)).toHaveLength(1);
    expect(buildDailyQueue([repeated, fresh], [event], settings, "card", today, true)).toHaveLength(2);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    expect(buildDailyQueue([repeated, fresh], [event], settings, "card", tomorrow).some((e) => e.sourceId === "b")).toBe(true);
  });
  it("counts prior due reviews even when no longer due, and keeps group budgets separate", () => {
    const settings = fixtureSettings(); settings.cardGroups[0].parameters.reviewLimit = 1;
    settings.cardGroups.push({ ...settings.cardGroups[0], id: "other", tags: ["other"] });
    const records = [fixtureRecord("a", ["#card"], fixtureItem("rv-one:qa", false)), fixtureRecord("b", ["#other"], fixtureItem("rv-one:qa", false))];
    const event = { ...reviewEvent("done", "deleted-source"), wasNew: false };
    expect(buildDailyQueue(records, [event], settings, "card", today).map((e) => e.sourceId)).toEqual(["b"]);
    const undo = { ...event, eventId: "undo", action: "undo" as const, undoOf: "done" };
    expect(buildDailyQueue(records, [event, undo], settings, "card", today)).toHaveLength(2);
  });
});
