import { describe, expect, it } from "vitest";
import { createGroup, normalizeSettings, parseSteps, parseTags, resolveGroup } from "../src/config";

describe("tag scopes and migration", () => {
  it("uses OR matching, descendant boundaries, case insensitivity and specificity", () => {
    const parent = { ...createGroup("note"), tags: ["TCM", "科研"] };
    const child = { ...createGroup("note"), tags: ["tcm/伤寒"] };
    expect(resolveGroup(["#Tcm/伤寒/太阳"], [parent, child])).toBe(child);
    expect(resolveGroup(["#科研/统计"], [parent, child])).toBe(parent);
    expect(resolveGroup(["#tcm-other"], [parent])).toBeUndefined();
    expect(resolveGroup(["#tcm/伤寒"], [child, { ...child, id: "second" }])?.id).toBe(child.id);
    expect(resolveGroup(["#tcm"], [{ ...parent, tags: [] }])).toBeUndefined();
  });
  it("migrates folder configuration into empty groups and preserves mode parameters", () => {
    const settings = normalizeSettings({ watchedFolders: ["资料"], excludedFolders: ["资料/归档"], noteNewLimit: 2, cardNewLimit: 30,
      noteReviewLimit: 15, cardReviewLimit: 200, noteRetention: 0.8, cardRetention: 0.95, dataFolder: "排程数据" });
    expect(settings.noteGroups[0].tags).toEqual([]);
    expect(settings.cardGroups[0].tags).toEqual([]);
    expect(settings.noteGroups[0].parameters).toMatchObject({ newLimit: 2, reviewLimit: 15, retention: 0.8 });
    expect(settings.cardGroups[0].parameters).toMatchObject({ newLimit: 30, reviewLimit: 200, retention: 0.95 });
    expect(settings.dataFolder).toBe("排程数据");
    expect(settings).not.toHaveProperty("watchedFolders");
    expect(normalizeSettings(settings)).toEqual(settings);
  });
  it("preserves empty v2 groups and disabled heatmaps across reload", () => {
    const settings = normalizeSettings({ noteGroups: [], cardGroups: [], showCardHeatmap: false });
    expect(normalizeSettings(settings)).toEqual(settings);
    expect(settings.showNoteHeatmap).toBe(true);
  });
  it("validates hierarchical tags and short learning steps without accepting broken input", () => {
    expect(parseTags("#TCM/伤寒, 科研\n#tcm/伤寒")).toEqual(["tcm/伤寒", "科研"]);
    expect(parseSteps("1m 0.5h")).toEqual(["1m", "0.5h"]);
    expect(parseSteps("")).toEqual([]);
    for (const input of ["0m", "24h", "1d", "10", "-1m", "1m junk"]) expect(() => parseSteps(input)).toThrow();
    for (const input of ["a//b", "a/", "123", "a:b"]) expect(() => parseTags(input)).toThrow();
  });
});
