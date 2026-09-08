import { describe, expect, it } from "vitest";
import { insertMissingBlockIds, parseReviewCards } from "../src/parser";
import { hashText } from "../src/utils";

const formats = [
  { name: "Basic", wrap: (body: string) => `START\nBasic\nFront: 问题\nBack: 答案${body}\nEND`, kind: "qa" },
  { name: "Q/A", wrap: (body: string) => `Q: 问题\nA: 答案${body}`, kind: "qa" },
  { name: "review Q/A", wrap: (body: string) => `> [!review]+\n> 问:: 问题\n> 答:: 答案${body.replace(/\n/g, "\n> ")}`, kind: "qa" },
  { name: "Cloze", wrap: (body: string) => `START\nCloze\nText: {{c1::甲}}和{{c2::乙}}${body}\nEND`, kind: "cloze" },
  { name: "body cloze", wrap: (body: string) => `{{c1::甲}}和{{c2::乙}}${body}`, kind: "cloze" },
  { name: "review cloze", wrap: (body: string) => `> [!review]+\n> {{c1::甲}}和{{c2::乙}}${body.replace(/\n/g, "\n> ")}`, kind: "cloze" },
];

describe("supplementary card content", () => {
  it.each(formats)("separates Extra content without generating cards from it: $name", ({ wrap, kind }) => {
    const extra = "解释 {{c9::仅补充}}\n![[附件/示意图.png|500]]";
    const markdown = wrap(`\nExtra: ${extra}`);
    const parsed = parseReviewCards(markdown);
    expect(parsed.valid).toBe(true);
    expect(parsed.cards).toHaveLength(kind === "qa" ? 1 : 2);
    for (const card of parsed.cards) {
      expect(card.content.extra).toBe(extra);
      expect(card.content.question).not.toContain("Extra:");
      expect(card.content.question).not.toContain("仅补充");
      expect(card.content.answer).not.toContain("Extra:");
    }
    const withId = insertMissingBlockIds(markdown, parsed.cards, () => "rv-fixed");
    const reparsed = parseReviewCards(withId);
    expect(reparsed.valid).toBe(true);
    expect(reparsed.cards.map(c => c.hash)).toEqual(parsed.cards.map(c => c.hash));
    expect(reparsed.cards.every(c => c.blockId === "rv-fixed")).toBe(true);
    expect(insertMissingBlockIds(withId, reparsed.cards, () => "rv-new")).toBe(withId);
  });

  it.each(formats)("empty Extra leaves hashes and supplementary display unchanged: $name", ({ wrap, kind, name }) => {
    const original = parseReviewCards(wrap("")).cards[0];
    const empty = parseReviewCards(wrap("\nExtra: ")).cards[0];
    expect(empty.hash).toBe(original.hash);
    expect(empty.content.extra).toBeUndefined();
    if (kind === "qa") expect(original.hash).toBe(hashText("qa\n问题\n答案"));
    if (name === "review cloze") expect(original.hash).toBe(hashText("cloze:1\n{{c1::甲}}和{{c2::乙}}"));
  });

  it("retains multi-paragraph Basic supplements and ignores code field examples", () => {
    const parsed = parseReviewCards("START\nBasic\nFront: 问题\nBack: 答案\n```md\nExtra: 示例\n```\n    Extra: 缩进示例\n`Extra: 行内示例`\nextra: 补充一\n\n![[图.png]]\nEND");
    expect(parsed.valid).toBe(true);
    expect(parsed.cards[0].content.answer).toContain("Extra: 示例");
    expect(parsed.cards[0].content.answer).toContain("Extra: 缩进示例");
    expect(parsed.cards[0].content.extra).toBe("补充一\n\n![[图.png]]");
  });

  it("does not treat a supplement as a missing answer or missing cloze", () => {
    for (const text of ["Q: 问题\nA: \nExtra: 仅补充", "START\nBasic\nFront: 问题\nBack:\nExtra: 仅补充\nEND", "> [!review]+\n> 问:: 问题\n> 答::\n> Extra: 仅补充"]) {
      expect(parseReviewCards(text).valid).toBe(false);
      expect(parseReviewCards(text).cards).toHaveLength(0);
    }
    expect(parseReviewCards("普通正文\nExtra: {{c1::仅补充}}").cards).toHaveLength(0);
  });

  it("keeps shorthand supplements within the same paragraph", () => {
    const parsed = parseReviewCards("Q: 问题\nA: 答案\nExtra: 补充\n\n第二段 {{c1::独立卡}}。");
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards[0].content.extra).toBe("补充");
    expect(parsed.cards[1].content.extra).toBeUndefined();
  });
});
