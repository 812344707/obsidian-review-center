import { describe, expect, it } from "vitest";
import { insertMissingBlockIds, parseReviewSection, renderCloze } from "../src/parser";

describe("parseReviewSection", () => {
  it("only parses cards inside the configured review section", () => {
    const markdown = [
      "问:: 正文里的内容不应成为卡片",
      "答:: 忽略",
      "",
      "## 复习",
      "### 基础",
      "问:: 什么是 FSRS？",
      "答::",
      "一种间隔重复排程算法。",
      "- 可以根据评分安排下次复习",
      "",
      "### 挖空",
      "这是 {{c1::一张::提示}} 挖空卡，另有 {{c2::第二处}}。",
    ].join("\n");

    const result = parseReviewSection(markdown, "复习", 2);

    expect(result.valid).toBe(true);
    expect(result.cards).toHaveLength(3);
    expect(result.cards[0].kind).toBe("qa");
    expect(result.cards[0].content.answer).toContain("间隔重复排程算法");
    expect(result.cards.slice(1).map((card) => card.clozeIndex)).toEqual([1, 2]);
  });

  it("does not create extra cloze cards from inside a question-answer block", () => {
    const markdown = [
      "## 复习",
      "问:: 这是问答卡吗？",
      "答:: 是，答案里的 {{c1::挖空}} 只作为答案文本。",
    ].join("\n");

    const result = parseReviewSection(markdown, "复习", 2);

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].kind).toBe("qa");
  });

  it("rejects duplicate root review sections instead of guessing", () => {
    const result = parseReviewSection("## 复习\n问:: 一\n答:: 二\n## 复习\n问:: 三\n答:: 四", "复习", 2);

    expect(result.valid).toBe(false);
    expect(result.cards).toHaveLength(0);
    expect(result.warnings[0]).toContain("只能有一个");
  });

  it("adds one stable block id for sibling clozes and reparses it", () => {
    const markdown = "## 复习\nA {{c1::one}} and {{c2::two}}.";
    const initial = parseReviewSection(markdown, "复习", 2);
    const withIds = insertMissingBlockIds(markdown, initial.cards, () => "rv-fixed");
    const reparsed = parseReviewSection(withIds, "复习", 2);

    expect(withIds).toContain("^rv-fixed");
    expect(reparsed.cards.map((card) => card.blockId)).toEqual(["rv-fixed", "rv-fixed"]);
  });

  it("ignores card-like text in fenced code blocks", () => {
    const markdown = [
      "## 复习",
      "```md",
      "问:: 示例",
      "答:: 不应生成",
      "{{c1::也不生成}}",
      "```",
    ].join("\n");

    expect(parseReviewSection(markdown, "复习", 2).cards).toHaveLength(0);
  });
});

describe("renderCloze", () => {
  it("groups the same cloze number and reveals other numbers", () => {
    const raw = "{{c1::甲::提示}}、{{c1::乙}}、{{c2::丙}}";
    expect(renderCloze(raw, 1, false)).toBe("[提示]、[…]、丙");
    expect(renderCloze(raw, 1, true)).toBe("==甲==、==乙==、丙");
  });
});
