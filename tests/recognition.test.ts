import { describe, expect, it } from "vitest";
import { normalizeSettings, resolveGroup } from "../src/config";
import { groupFilter, matchesRule, validateRecognition } from "../src/recognition";
import { buildReviewTree } from "../src/tree";
import { collectEntries } from "../src/queue";
import { fixtureSettings, fixtureRecord } from "./fixtures";

describe("independent recognition scopes", () => {
  it("keeps old tag groups identical and prefers specific matching groups", () => {
    const settings = fixtureSettings(), g = settings.noteGroups[0];
    const nested = { ...g, id: "child", tags: ["note/细节"] };
    expect(groupFilter(g).rules[0]).toEqual({ field: "tag", operator: "contains", value: "note" });
    expect(resolveGroup(["#NOTE/细节"], [g, nested])?.id).toBe("child");
    expect(normalizeSettings(settings).noteGroups[0].recognition).toBeUndefined();
  });
  it("distinguishes exact and nested folders and does not match similar prefixes", () => {
    const rule = { field: "folder", operator: "is", value: "学习" } as const;
    expect(matchesRule([], "学习/a.md", rule)).toBe(true);
    expect(matchesRule([], "学习/子/a.md", rule)).toBe(false);
    expect(matchesRule([], "学习/子/a.md", { ...rule, operator: "contains" })).toBe(true);
    expect(matchesRule([], "学习二/a.md", { ...rule, operator: "contains" })).toBe(false);
    expect(matchesRule([], "根笔记.md", { ...rule, value: "/" })).toBe(true);
    expect(matchesRule([], "学习/a.md", { ...rule, value: "/", operator: "contains" })).toBe(true);
  });
  it("distinguishes exact and nested tag exclusion", () => {
    const rule = { field: "tag", operator: "is-not", value: "草稿" } as const;
    expect(matchesRule(["#草稿/待补"], "a.md", rule)).toBe(true);
    expect(matchesRule(["#草稿/待补"], "a.md", { ...rule, operator: "excludes" })).toBe(false);
    expect(matchesRule(["#草稿箱"], "a.md", { ...rule, operator: "excludes" })).toBe(true);
  });
  it("combines folder inclusion and tag exclusion without relying on old tags", () => {
    const g = fixtureSettings().noteGroups[0];
    g.recognition = { match: "all", rules: [{ field: "folder", operator: "contains", value: "学习" }, { field: "tag", operator: "excludes", value: "草稿" }] };
    expect(resolveGroup([], [g], "学习/a.md")).toBe(g);
    expect(resolveGroup(["草稿"], [g], "学习/a.md")).toBeUndefined();
    expect(resolveGroup(["note"], [g], "其他/a.md")).toBeUndefined();
    g.recognition.match = "any";
    expect(resolveGroup(["草稿"], [g], "学习/a.md")).toBe(g);
  });
  it("keeps note and card scopes independent throughout queues and the home tree", () => {
    const settings = fixtureSettings(), record = fixtureRecord();
    record.sourcePath = "学习/a.md"; record.tags = [];
    settings.noteGroups[0].recognition = { match: "all", rules: [{ field: "folder", operator: "contains", value: "学习" }] };
    expect(collectEntries([record], "note", settings)).toHaveLength(1);
    expect(collectEntries([record], "card", settings)).toHaveLength(0);
    expect(buildReviewTree([record], settings, "note")[0].groupId).toBe(settings.noteGroups[0].id);
  });
  it("fails closed for corrupted conditions and rejects incomplete drafts", () => {
    const settings = fixtureSettings();
    settings.noteGroups[0].recognition = { match: "all", rules: [{ field: "folder", operator: "contains", value: "../其他" }] };
    const normalized = normalizeSettings(settings);
    expect(resolveGroup(["note"], normalized.noteGroups, "学习/a.md")).toBeUndefined();
    expect(() => validateRecognition({ match: "any", rules: [{ field: "tag", operator: "is", value: "" }] })).toThrow("请填写");
  });
});
