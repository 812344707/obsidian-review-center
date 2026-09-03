import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ getAllTags: (cache: { tags?: string[] }) => cache.tags ?? [], getFrontMatterInfo: () => ({ exists: false }), parseYaml: () => ({}), stringifyYaml: (value: unknown) => JSON.stringify(value) + "\n" }));
import { collectVaultTags, matchesFolder, matchesTags, applyBulkTags, type BulkTagRequest } from "../src/tags";
import type { App } from "obsidian";
import { fixtureSettings } from "./fixtures";

describe("bulk tag selection", () => {
  it("supports any/all matching with descendant boundaries", () => {
    expect(matchesTags(["#资料/伤寒/太阳", "#学习"], ["资料", "学习"], "all")).toBe(true);
    expect(matchesTags(["#资料/伤寒"], ["资料", "学习"], "all")).toBe(false);
    expect(matchesTags(["#资料/伤寒"], ["资料", "学习"], "any")).toBe(true);
    expect(matchesTags(["#资料库"], ["资料"])).toBe(false);
    expect(matchesTags(["#资料"], [], "all")).toBe(false);
  });
  it("handles root selection and optional folder recursion", () => {
    expect(matchesFolder("a/b/c.md", "a", true)).toBe(true);
    expect(matchesFolder("a/b/c.md", "a", false)).toBe(false);
    expect(matchesFolder("ab/c.md", "a", true)).toBe(false);
    expect(matchesFolder("root.md", "", false)).toBe(true);
    expect(matchesFolder("a/root.md", "", false)).toBe(false);
  });
  it("suggests inferred parent tags without duplicates", () => {
    const files = [{ tags: ["#资料/伤寒/太阳"] }, { tags: ["#资料/伤寒", "#学习"] }];
    const app = { vault: { getMarkdownFiles: () => files }, metadataCache: { getFileCache: (file: unknown) => file } } as unknown as App;
    expect(collectVaultTags(app)).toEqual(expect.arrayContaining(["资料", "资料/伤寒", "资料/伤寒/太阳", "学习"]));
    expect(collectVaultTags(app)).toHaveLength(4);
  });
  it("skips edited or unselected files and reports independent failures", async () => {
    const files = [{ path: "a/changed.md", content: "edited" }, { path: "a/unselected.md", content: "original" }];
    const app = { vault: {
      getMarkdownFiles: () => files,
      process: vi.fn(async (file: typeof files[0], fn: (text: string) => string) => { file.content = fn(file.content); }),
    }, metadataCache: { getFileCache: () => ({ tags: ["#资料"] }) } } as unknown as App;
    const request: BulkTagRequest = { target: "folder", folder: "a", recursive: true, match: "any", tags: [], additions: ["复习"] };
    const preview = files.map((file) => ({ path: file.path, original: "original", knownTags: ["资料"], additions: ["复习"], selected: file.path.includes("changed") }));
    const result = await applyBulkTags(app, fixtureSettings(), request, preview);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "failed" });
    expect(result[0].message).toContain("预览后发生修改");
    expect(files.map((file) => file.content)).toEqual(["edited", "original"]);
  });
});
