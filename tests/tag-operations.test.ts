import { describe, expect, it, vi } from "vitest";
function frontmatter(markdown: string) {
  const start = markdown.startsWith("---\n") ? 4 : -1, close = start >= 0 ? markdown.indexOf("\n---", start) : -1;
  return close >= 0 ? { exists: true, frontmatter: markdown.slice(start, close + 1), from: start, to: close + 1, contentStart: close + 5 } : { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
}
vi.mock("obsidian", () => ({
  getFrontMatterInfo: frontmatter, getAllTags: (cache: { all?: string[] }) => cache.all ?? [],
  Modal: class {}, Setting: class {}, Notice: class {}, AbstractInputSuggest: class {}, TFolder: class {},
}));
import { rewriteTagReferences, transformTags, validateTagOperation } from "../src/tag-operations";
import { fixtureSettings } from "./fixtures";
function inline(markdown: string, tag: string, from = 0) { const start = markdown.indexOf(tag, from); return { tag, position: { start: { offset: start, line: 0, col: start }, end: { offset: start + tag.length, line: 0, col: start + tag.length } } }; }
describe("vault-wide tag rewrite", () => {
  it("merges an already present body tag without leaving duplicate valid tags", () => {
    const md = "#中医/伤寒 #医学/伤寒";
    expect(transformTags(md, { tags: [inline(md, "#中医/伤寒"), inline(md, "#医学/伤寒")] }, { from: "中医", to: "医学" }).text).toBe(" #医学/伤寒");
  });
  it("renames a property subtree and deduplicates an existing target", () => {
    const md = "---\ntitle: Test # keep\ntags: [中医/伤寒, 医学/伤寒]\n---\n正文\n";
    const out = transformTags(md, { tags: [] }, { from: "中医", to: "医学" });
    expect(out.text).toContain("title: Test # keep"); expect(out.text.match(/医学\/伤寒/g)).toHaveLength(1); expect(out.changes[0]).toContain("属性");
  });
  it("changes cached inline tags but preserves code examples and near prefixes", () => {
    const md = "正文 #中医/伤寒 和 #中医基础\n```md\n#中医/伤寒\n```\n";
    const cache = { tags: [inline(md, "#中医/伤寒"), inline(md, "#中医基础")] };
    const out = transformTags(md, cache, { from: "中医", to: "医学" }).text;
    expect(out).toContain("正文 #医学/伤寒 和 #中医基础"); expect(out).toContain("```md\n#中医/伤寒");
  });
  it("deletes tags without deleting surrounding note text", () => {
    const md = "甲 #中医/伤寒 乙";
    expect(transformTags(md, { tags: [inline(md, "#中医/伤寒")] }, { from: "中医" }).text).toBe("甲  乙");
  });
  it("rejects invalid tags, self descendants and stale offsets", () => {
    expect(() => validateTagOperation({ from: "中医", to: "中医/伤寒" })).toThrow("自身子级");
    expect(() => validateTagOperation({ from: "1" })).toThrow();
    expect(() => transformTags("#别的", { tags: [{ tag: "#中医", position: { start: { offset: 0 }, end: { offset: 3 } } }] } as never, { from: "中医" })).toThrow("索引已变化");
  });
  it("updates both modes and node paths while retaining old references after partial work", () => {
    const s = fixtureSettings(); s.noteGroups[0].tags = ["中医"]; s.noteGroups[0].nodes = { "中医/伤寒": { retention: .95 } };
    const full = rewriteTagReferences(s, { from: "中医", to: "医学" }, false);
    expect(full.noteGroups[0].tags).toEqual(["医学"]); expect(full.noteGroups[0].nodes?.["医学/伤寒"]?.retention).toBe(.95); expect(full.noteGroups[0].nodes?.["中医/伤寒"]).toBeUndefined();
    expect(rewriteTagReferences(s, { from: "中医", to: "医学" }, true).noteGroups[0].tags).toEqual(["中医", "医学"]);
  });
  it("adds a moved child root when the new path leaves a configured ancestor", () => {
    const s = fixtureSettings(); s.cardGroups[0].tags = ["中医"];
    expect(rewriteTagReferences(s, { from: "中医/伤寒", to: "医学/伤寒" }, false).cardGroups[0].tags).toEqual(["中医", "医学/伤寒"]);
  });
});
