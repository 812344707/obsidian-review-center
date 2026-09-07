import { describe, expect, it } from "vitest";
import { normalizeSettings, resolveGroup } from "../src/config";
import { groupLabel, groupTag, replaceGroupTag, setReviewTags, tagGroups } from "../src/tag-groups";
import { buildDailyQueue, getQueueCounts } from "../src/queue";
import { buildReviewTree } from "../src/tree";
import { fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";

describe("custom tags as review groups", () => {
  it("adds one group per tag with independent day and card defaults, retaining existing IDs and options", () => {
    const settings = fixtureSettings(), original = settings.noteGroups[0];
    original.nodes = { "note/伤寒": { limits: { newLimit: 3 } } };
    original.parameters.retention = .8;
    const before = structuredClone(original), cards = structuredClone(settings.cardGroups);
    setReviewTags(settings, "note", ["#NOTE", "医学", "#医学"]);
    expect(settings.noteGroups).toHaveLength(2);
    expect(settings.noteGroups[0]).toEqual(before);
    expect(settings.noteGroups[1]).toMatchObject({ tags: ["医学"], parameters: { newLimit: 1, reviewLimit: 10, maximumInterval: 90, learningSteps: [] } });
    expect(settings.cardGroups).toEqual(cards);
    setReviewTags(settings, "card", ["card", "英语"]);
    expect(settings.cardGroups[1].parameters).toMatchObject({ newLimit: 10, reviewLimit: 100, learningSteps: ["1m", "10m"] });
    const normalized = normalizeSettings(settings);
    expect(normalizeSettings(normalized)).toEqual(normalized);
    expect(normalized.noteGroups[0].id).toBe(original.id);
    expect(normalized.noteGroups[0].parameters.retention).toBe(.8);
  });

  it("shows tag names and automatic subgroups while keeping matching boundaries and mode independence", () => {
    const settings = fixtureSettings();
    setReviewTags(settings, "note", ["医学"]);
    setReviewTags(settings, "card", ["英语"]);
    const records = [fixtureRecord("a", ["#医学/第2章"]), fixtureRecord("b", ["#医学/第10章"]), fixtureRecord("c", ["医学基础"]), fixtureRecord("d", ["#英语/阅读"])];
    const tree = buildReviewTree(records, settings, "note");
    expect(tree.map((node) => node.label)).toEqual(["#医学"]);
    expect(tree[0].children.map((node) => node.label)).toEqual(["第2章", "第10章"]);
    expect(buildDailyQueue(records, [], settings, "note", today, true).map((entry) => entry.sourceId)).toEqual(["a", "b"]);
    expect(buildDailyQueue(records, [], settings, "card", today, true).map((entry) => entry.sourceId)).toEqual(["d"]);
  });

  it("keeps overlapping tags deterministic and does not reset today's existing quota", () => {
    const settings = fixtureSettings(), id = settings.cardGroups[0].id;
    settings.cardGroups[0].parameters.newLimit = 1;
    setReviewTags(settings, "card", ["card", "card/细节", "other"]);
    const specific = resolveGroup(["#CARD/细节/a", "other"], settings.cardGroups)!;
    expect(groupTag(specific)).toBe("card/细节");
    setReviewTags(settings, "card", ["other", "card/细节", "card"]);
    expect(settings.cardGroups[0].id).toBe(id);
    const records = [fixtureRecord("a", ["card/细节/a", "other"]), fixtureRecord("b", ["card"])];
    expect(new Set(buildDailyQueue(records, [], settings, "card", today, true).map((entry) => entry.sourceId)).size).toBe(2);
    expect(getQueueCounts(records, [reviewEvent("existing", "prior")], settings, "card", today, id).new).toBe(0);
  });

  it("keeps legacy folder, exact-tag, exclusion and multiple-tag scopes intact until explicitly replaced", () => {
    const settings = fixtureSettings(), base = settings.noteGroups[0];
    settings.noteGroups = [
      { ...structuredClone(base), id: "folder", recognition: { match: "all", rules: [{ field: "folder", operator: "contains", value: "资料" }, { field: "tag", operator: "excludes", value: "草稿" }] } },
      { ...structuredClone(base), id: "exact", recognition: { match: "any", rules: [{ field: "tag", operator: "is", value: "note" }] } },
      { ...structuredClone(base), id: "multiple", tags: ["甲", "乙"] },
    ];
    const before = structuredClone(settings.noteGroups);
    setReviewTags(settings, "note", ["新标签"]);
    expect(settings.noteGroups.slice(0, 3)).toEqual(before);
    expect(tagGroups(settings.noteGroups)).toHaveLength(1);
    expect(groupLabel(settings.noteGroups[0])).toBe(base.name);
    expect(resolveGroup(["草稿"], settings.noteGroups, "资料/a.md")).toBeUndefined();
    replaceGroupTag(settings, "note", "folder", "#已整理");
    expect(settings.noteGroups[0]).toMatchObject({ id: "folder", tags: ["已整理"], nodes: before[0].nodes, parameters: before[0].parameters });
    expect(settings.noteGroups[0].recognition).toBeUndefined();
    expect(resolveGroup([], settings.noteGroups, "资料/a.md")).toBeUndefined();
    expect(resolveGroup(["已整理/经典"], settings.noteGroups, "其他/a.md")?.id).toBe("folder");
  });

  it("rejects invalid or ambiguous replacements without altering settings", () => {
    const settings = fixtureSettings();
    setReviewTags(settings, "note", ["note", "另一组"]);
    const before = structuredClone(settings), id = settings.noteGroups[0].id;
    for (const invalid of ["", "a b", "a//b", "123", "另一组"]) expect(() => replaceGroupTag(settings, "note", id, invalid)).toThrow();
    expect(() => setReviewTags(settings, "note", ["bad//tag"])).toThrow();
    expect(settings).toEqual(before);
  });

  it("removes a tag without changing source records or history and can resume an existing schedule after re-adding", () => {
    const settings = fixtureSettings(), records = [fixtureRecord("a", ["note"])], history = [reviewEvent("existing", "a", "note")];
    records[0].note.schedule = structuredClone(history[0].after!.schedule);
    const before = JSON.stringify([records, history]);
    setReviewTags(settings, "note", []);
    expect(buildDailyQueue(records, history, settings, "note", today, true)).toEqual([]);
    setReviewTags(settings, "note", ["note"]);
    const queue = buildDailyQueue(records, history, settings, "note", today, true);
    expect(queue[0].item.schedule).toEqual(records[0].note.schedule);
    expect(JSON.stringify([records, history])).toBe(before);
  });
});
