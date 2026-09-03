import { describe, expect, it } from "vitest";
import { calloutRanges, convertLegacySection, insertMissingBlockIds, parseReviewCallouts, parseReviewSection, renderCloze } from "../src/parser";
const tick = String.fromCharCode(96);
describe("review callouts", () => {
  it("finds multiple default/custom blocks with physical positions, ignoring unrelated text", () => {
    const markdown = [
      "# 原文章", "问:: 不制卡", "答:: 正文",
      "> [!note]- 普通提示", "> {{c1::不制卡}}", "",
      "> [!review]- 任意标题", "> 问:: 问题", "> 答:: 答案", "> ^rv-qa", "",
      "## 原文章下一节", "> [!study]+ 自定义", "> A {{c1::甲}} / {{c2::乙}}", "> ^rv-cloze", "",
    ].join("\n");
    const parsed = parseReviewCallouts(markdown, ["review", "study"]);
    expect(parsed.valid).toBe(true);
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.cards[0]).toMatchObject({ blockId: "rv-qa", insertIdPrefix: "> ", content: { sourceStartLine: 7, sourceEndLine: 8, answer: "答案" } });
    expect(parsed.cards[1].content.sourceStartLine).toBe(13);
    expect(parsed.cards[2].clozeIndex).toBe(2);
  });
  it("writes one quoted identity for sibling clozes and preserves it on repeated scans", () => {
    const text = "> [!review]-\n> {{c1::甲}}，{{c2::乙}}\n";
    const withIds = insertMissingBlockIds(text, parseReviewCallouts(text).cards, () => "rv-stable");
    expect(withIds).toContain("> ^rv-stable");
    const cards = parseReviewCallouts(withIds).cards;
    expect(cards.map((card) => card.blockId)).toEqual(["rv-stable", "rv-stable"]);
    expect(insertMissingBlockIds(withIds, cards, () => "rv-new")).toBe(withIds);
  });
  it("ignores fenced examples, comments and nested independent cards", () => {
    const text = [
      tick.repeat(4) + "md", tick.repeat(3), "> [!review]-", "> {{c1::示例}}", tick.repeat(4), "",
      "%%", "> [!review]-", "> {{c1::注释}}", "%%", "",
      "<!--", "## 复习", "> [!review]-", "> {{c1::注释}}", "-->", "",
      "> [!review]-", "> > [!review]-", "> > {{c1::嵌套}}", ">", "> {{c1::真实}}",
    ].join("\n");
    expect(parseReviewCallouts(text).cards).toHaveLength(1);
    expect(parseReviewCallouts(text).cards[0].content.raw).toBe("{{c1::真实}}");
    expect(convertLegacySection(text, "复习", 2).changed).toBe(false);
  });
  it("rejects broken answers, duplicate identities and unclosed fences", () => {
    for (const body of [
      "> 问:: 没有答案",
      "> 问:: A\n> 答:: B\n> ^rv-dup\n> 问:: C\n> 答:: D\n> ^rv-dup",
      "> {{c1::A}}\n> ^rv-dup\n>\n> {{c2::B}}\n> ^rv-dup",
      "> 问:: A\n> 答:: B\n> " + tick.repeat(3),
    ]) expect(parseReviewCallouts("> [!review]-\n" + body).valid).toBe(false);
  });
  it("keeps inline and indented code examples literal without creating cards", () => {
    const inline = tick + "{{c9::代码示例}}" + tick;
    const body = ["> [!review]-", ">     问:: 代码问题", ">     答:: 代码答案", ">     {{c8::缩进代码}}", ">", "> " + inline, ">", "> 真实 {{c1::答案}}，示例 " + inline].join("\n");
    const cards = parseReviewCallouts(body).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].clozeIndex).toBe(1);
    expect(renderCloze(cards[0].content.raw, 1, false)).toBe("真实 […]，示例 " + inline);
  });
  it("does not scan unconfigured types or ordinary blockquotes", () => {
    expect(parseReviewCallouts("> [!other]-\n> {{c1::A}}").cards).toHaveLength(0);
    expect(calloutRanges("> 普通引用\n> > [!review]\n> > {{c1::A}}")).toHaveLength(0);
  });
});

describe("legacy conversion", () => {
  const old = "# 文章\r\n\r\n正文保持原样。\r\n\r\n## 复习\r\n\r\n### 问答\r\n问:: A\r\n答:: B\r\n^rv-a\r\n\r\n### 挖空\r\n{{c1::C}} {{c2::D}}\r\n^rv-c\r\n\r\n## 后续正文\r\n继续阅读。\r\n";
  it("preserves hashes, identities, body outside the section and newline format", () => {
    const before = parseReviewSection(old, "复习", 2);
    const conversion = convertLegacySection(old, "复习", 2);
    expect(conversion.warnings).toEqual([]);
    expect(conversion.changed).toBe(true);
    const after = parseReviewCallouts(conversion.markdown);
    expect(after.cards.map((card) => [card.hash, card.blockId])).toEqual(before.cards.map((card) => [card.hash, card.blockId]));
    expect(conversion.markdown.startsWith("# 文章\r\n\r\n正文保持原样。\r\n\r\n")).toBe(true);
    expect(conversion.markdown.endsWith("\r\n## 后续正文\r\n继续阅读。\r\n")).toBe(true);
    expect(conversion.markdown.replace(/\r\n/g, "")).not.toContain("\n");
    expect(convertLegacySection(conversion.markdown, "复习", 2).changed).toBe(false);
  });
  it("preserves mixed new and old independent blocks without duplication", () => {
    const mixed = "> [!review]-\n> {{c1::已有}}\n> ^rv-existing\n\n" + old.replace(/\r\n/g, "\n");
    const conversion = convertLegacySection(mixed, "复习", 2);
    expect(conversion.changed).toBe(true);
    expect(parseReviewCallouts(conversion.markdown).cards).toHaveLength(4);
  });
  it("leaves ambiguous headings or nested existing callouts untouched", () => {
    for (const text of [
      "## 复习\n问:: A\n答:: B\n## 复习\n问:: C\n答:: D",
      "## 复习\n问:: A\n答:: B\n\n> [!note]\n> {{c1::嵌套}}",
      "## 复习\n问:: A\n答:: B\n^rv-dup\n问:: C\n答:: D\n^rv-dup",
    ]) {
      const conversion = convertLegacySection(text, "复习", 2);
      expect(conversion.changed).toBe(false);
      expect(conversion.markdown).toBe(text);
      expect(conversion.warnings.length).toBeGreaterThan(0);
    }
  });
});
