import { describe, expect, it } from "vitest";
import { buildReviewTree, flattenTree } from "../src/tree";
import { nodeParameters, normalizeSettings, parameterPath } from "../src/config";
import { buildDailyQueue, getQueueCounts } from "../src/queue";
import { fixtureItem, fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";
import { localDayKey } from "../src/utils";

describe("tree and scoped queue", () => {
  it("hides a single redundant root, keeps natural hierarchy and excludes unrelated tags", () => {
    const s = fixtureSettings(), records = [fixtureRecord("a", ["card/第10章/节", "other"]), fixtureRecord("b", ["card/第2章"]), fixtureRecord("c", ["cardinal"])];
    const tree = buildReviewTree(records, s, "card");
    expect(tree[0].children.map((n) => n.label)).toEqual(["第2章", "第10章"]);
    expect(flattenTree(tree).map((n) => n.tagPath)).toEqual([undefined, "card/第2章", "card/第10章", "card/第10章/节"]);
  });
  it("shows several configured roots but assigns overlapping groups only once", () => {
    const s = fixtureSettings(); s.cardGroups[0].tags.push("医学");
    s.cardGroups.push({ ...s.cardGroups[0], id: "specific", tags: ["card/child"] });
    const records = [fixtureRecord("a", ["card/child/a"]), fixtureRecord("b", ["医学/骨科"])];
    const tree = buildReviewTree(records, s, "card");
    expect(tree[0].children.map((n) => n.label)).toContain("医学");
    expect(flattenTree(tree[0].children).map((n) => n.tagPath)).not.toContain("card/child/a");
    expect(getQueueCounts(records, [], s, "card", today).new).toBe(2);
  });
  it("counts duplicate tag placements once at parent and in a session", () => {
    const s = fixtureSettings(), records = [fixtureRecord("a", ["card/a", "card/b"])];
    expect(getQueueCounts(records, [], s, "card", today, "default-card", "card/a").new).toBe(1);
    expect(getQueueCounts(records, [], s, "card", today, "default-card", "card/b").new).toBe(1);
    expect(buildDailyQueue(records, [], s, "card", today)).toHaveLength(1);
  });
  it("splits due learning, review and fresh while omitting future/buried items", () => {
    const s = fixtureSettings();
    const learning = fixtureItem("learning", false); learning.schedule.state = 1;
    const future = fixtureItem("future", false, new Date(today.getTime() + 60000)); future.schedule.state = 3;
    const buried = fixtureItem("buried"); buried.buriedUntil = "2026-09-04";
    const records = [fixtureRecord("n", ["card"]), fixtureRecord("l", ["card"], learning), fixtureRecord("r", ["card"], fixtureItem("review", false)), fixtureRecord("f", ["card"], future), fixtureRecord("b", ["card"], buried)];
    expect(getQueueCounts(records, [], s, "card", today)).toMatchObject({ new: 1, learning: 1, review: 1, due: 2 });
    expect(buildDailyQueue(records, [], s, "card", new Date(2026, 8, 4, 10)).some((e) => e.item.id === "buried")).toBe(true);
  });
  it("applies today then current-node then preset limits and expires only today's override", () => {
    const s = fixtureSettings(), g = s.cardGroups[0];
    g.nodes = { "card/a": { limits: { newLimit: 2 }, today: { date: localDayKey(today), newLimit: 0 } } };
    const records = [fixtureRecord("a", ["card/a"]), fixtureRecord("b", ["card/a/b"])];
    expect(buildDailyQueue(records, [], s, "card", today, false, g.id, "card/a")).toHaveLength(0);
    expect(buildDailyQueue(records, [], s, "card", new Date(2026, 8, 4), false, g.id, "card/a")).toHaveLength(2);
    delete g.nodes["card/a"].today; g.nodes["card/a"].limits!.newLimit = 1;
    expect(buildDailyQueue(records, [], s, "card", today, false, g.id, "card/a")).toHaveLength(1);
  });
  it("only constrains a selected subtag by root quota when enabled", () => {
    const s = fixtureSettings(), g = s.cardGroups[0]; g.parameters.newLimit = 1;
    g.nodes = { "card/a": { limits: { newLimit: 5 } } };
    const records = [fixtureRecord("a", ["card/a"]), fixtureRecord("b", ["card/a"])];
    expect(buildDailyQueue(records, [], s, "card", today, false, g.id, "card/a")).toHaveLength(2);
    g.parameters.limitsFromTop = true;
    expect(buildDailyQueue(records, [], s, "card", today, false, g.id, "card/a")).toHaveLength(1);
  });
  it("shares consumption across tag placements and distinguishes independent new/review caps", () => {
    const s = fixtureSettings(), g = s.cardGroups[0]; g.parameters.reviewLimit = 1; g.parameters.newLimit = 5;
    const records = [fixtureRecord("a", ["card/a"]), fixtureRecord("b", ["card/a"], fixtureItem("rv-one:qa", false))];
    expect(buildDailyQueue(records, [], s, "card", today)).toHaveLength(2);
    g.parameters.newIgnoreReviewLimit = false;
    expect(buildDailyQueue(records, [], s, "card", today)).toHaveLength(1);
    const history = [{ ...reviewEvent("first", "other"), wasNew: true, sourceTags: ["card/a", "card/b"] }];
    g.nodes = { "card/b": { limits: { newLimit: 1 } } };
    expect(getQueueCounts([fixtureRecord("c", ["card/b"])], history, s, "card", today, g.id, "card/b").new).toBe(0);
  });
  it("uses the most specific tag's preset regardless of chosen display branch", () => {
    const s = fixtureSettings(), g = s.cardGroups[0];
    s.presets!.push({ id: "deep", name: "深层", mode: "card", parameters: { ...g.parameters, retention: .95 } });
    g.nodes = { "card/deep": { presetId: "deep", retention: .96 } };
    expect(parameterPath(["card/z", "card/deep/child"], g)).toBe("card/deep/child");
    expect(nodeParameters(s, "card", g, "card/deep/child").parameters.retention).toBe(.96);
    const records = [fixtureRecord("a", ["card/z", "card/deep/child"])];
    expect(buildDailyQueue(records, [], s, "card", today, false, g.id, "card/z")[0].presetId).toBe("deep");
  });
  it("retains deterministic ordering, and applies before/after choices", () => {
    const s = fixtureSettings(), p = s.cardGroups[0].parameters;
    const records = Array.from({ length: 6 }, (_, i) => fixtureRecord(String(i), ["card"], fixtureItem(String(i), i < 4)));
    p.newSort = "random"; p.reviewSort = "random"; p.newOrder = "before";
    const queue = () => buildDailyQueue(records, [], s, "card", today, false, undefined, undefined, "saved-seed").map((e) => e.item.id);
    expect(queue()).toEqual(queue()); expect(queue().slice(0, 4).every((id) => +id < 4)).toBe(true);
    p.newOrder = "after"; expect(+queue()[0]).toBeGreaterThanOrEqual(4);
  });
  it("migrates each v3 group to an independent preset without touching parameters", () => {
    const base = fixtureSettings(); const raw = { ...base, presets: undefined, cardGroups: base.cardGroups.map((g) => ({ ...g, presetId: undefined, parameters: { ...g.parameters, retention: .93 } })) };
    const upgraded = normalizeSettings(raw);
    expect(upgraded.cardGroups[0].parameters.retention).toBe(.93);
    expect(upgraded.presets?.find((p) => p.id === upgraded.cardGroups[0].presetId)?.parameters.retention).toBe(.93);
    expect(normalizeSettings(JSON.parse(JSON.stringify(upgraded)))).toEqual(upgraded);
  });
});
