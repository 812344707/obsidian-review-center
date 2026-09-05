import { describe, expect, it } from "vitest";
import { insertMissingBlockIds, parseReviewCards, parseReviewSection, renderCloze } from "../src/parser";

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
    expect(renderCloze(raw, 1, false)).toBe("==提示==、==\u2060==、丙");
    expect(renderCloze(raw, 1, true)).toBe("==甲==、==乙==、丙");
  });
});

describe("parseReviewCards", () => {
  it("parses standard Basic, shorthand Q/A and standalone Cloze in source order", () => {
    const markdown = [
      "START", "Basic", "Front: 标准问题", "Back: 第一段", "", "第二段", "END", "",
      "Q: 简写问题", "A: 简写答案", "", "正文 {{c1::甲::提示}} 与 {{c2::乙}}。",
    ].join("\n");
    const parsed = parseReviewCards(markdown);
    expect(parsed.valid).toBe(true);
    expect(parsed.cards.map((card) => card.kind === "qa" ? card.content.question : `c${card.clozeIndex}`))
      .toEqual(["标准问题", "简写问题", "c1", "c2"]);
    expect(parsed.cards[0].content.answer).toBe("第一段\n\n第二段");
  });

  it("supports omitted first field labels and Cloze Extra", () => {
    const basic = parseReviewCards("START\nBasic\n省略 Front 的问题\nBack: 答案\nEND");
    expect(basic.cards[0].content).toMatchObject({ question: "省略 Front 的问题", answer: "答案" });
    const cloze = parseReviewCards("START\nCloze\n句子 {{c1::答案}}\nExtra: 补充材料\nEND");
    expect(cloze.cards[0]).toMatchObject({ clozeIndex: 1, content: { extra: "补充材料" } });
  });

  it("does not turn clozes owned by a shorthand answer into extra cards", () => {
    const parsed = parseReviewCards("Q: 问题\nA: 答案里有 {{c1::示例}}\n\n独立 {{c2::挖空}}。");
    expect(parsed.cards).toHaveLength(2);
    expect(parsed.cards.map((card) => card.kind)).toEqual(["qa", "cloze"]);
    expect(parsed.cards[1].clozeIndex).toBe(2);
  });

  it("ignores frontmatter, comments, code and all callout-owned direct syntax", () => {
    const markdown = [
      "---", "sample: '{{c1::属性}}'", "---", "",
      "```md", "Q: 代码", "A: 示例", "{{c2::代码}}", "```", "",
      "<!-- Q: 注释\nA: 示例 -->", "%% {{c3::注释}} %%", "",
      "> [!note]", "> Q: 普通提示", "> A: 不制卡", "",
      "> [!review]", "> 问:: 旧问题", "> 答:: 旧答案", "> ^rv-old",
    ].join("\n");
    const parsed = parseReviewCards(markdown);
    expect(parsed.valid).toBe(true);
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]).toMatchObject({ blockId: "rv-old", kind: "qa" });
  });

  it("does not include an adjacent fenced or indented example in a body cloze", () => {
    const markdown = [
      "```md", "{{c1::代码}}", "```", "紧接的 {{c2::正文}}。", "",
      "    {{c3::缩进代码}}", "另一段 {{c4::内容}}。",
    ].join("\n");
    const parsed = parseReviewCards(markdown);
    expect(parsed.cards.map((card) => card.clozeIndex)).toEqual([2, 4]);
    expect(parsed.cards[0].content.raw).toBe("紧接的 {{c2::正文}}。");
  });

  it("does not use field markers from code examples", () => {
    const direct = parseReviewCards("Q: 外部问题\n```md\nA: 代码答案\n```\n\n独立 {{c1::内容}}。");
    expect(direct.cards).toHaveLength(1);
    expect(direct.cards[0].kind).toBe("cloze");
    expect(direct.warnings.join()).toContain("缺少 A:");
    const standard = parseReviewCards([
      "START", "Basic", "Front: 问题", "```md", "Back: 代码字段", "```", "Back: 真实答案", "END",
    ].join("\n"));
    expect(standard.cards[0].content.answer).toBe("真实答案");
  });

  it("writes one hidden ID per body card, preserves CRLF and leaves Anki IDs untouched", () => {
    const markdown = "Q: 问题\r\nA: 答案\r\n<!--ID: 1700000000000-->\r\n\r\n句子 {{c1::甲}} 和 {{c2::乙}}。\r\n";
    let serial = 0;
    const withIds = insertMissingBlockIds(markdown, parseReviewCards(markdown).cards, () => `rv-${++serial}`);
    expect(withIds.replace(/\r\n/g, "")).not.toContain("\n");
    expect(withIds).toContain("<!--ID: 1700000000000-->");
    expect(withIds.match(/<!--review-center-id: rv-/g)).toHaveLength(2);
    const reparsed = parseReviewCards(withIds);
    const ids = reparsed.cards.map((card) => card.blockId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).toBe(ids[2]);
    expect(insertMissingBlockIds(withIds, reparsed.cards, () => "rv-new")).toBe(withIds);
  });

  it("reports orphaned and physically duplicated plugin IDs without guessing ownership", () => {
    const orphaned = parseReviewCards("普通正文\n<!--review-center-id: rv-orphan-->\n");
    expect(orphaned.valid).toBe(false);
    expect(orphaned.warnings.join()).toContain("无法确定归属");
    const duplicated = parseReviewCards([
      "Q: 第一题", "A: 第一答", "<!--review-center-id: rv-dup-->", "",
      "Q: 第二题", "A: 第二答", "<!--review-center-id: rv-dup-->",
    ].join("\n"));
    expect(duplicated.valid).toBe(false);
    expect(duplicated.warnings.join()).toContain("重复");
  });
});
