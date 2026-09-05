import { describe, expect, it } from "vitest";
import { cardAuthoringEdit, type CardAuthoringAction } from "../src/card-authoring";
import { parseReviewCallouts, parseReviewCards } from "../src/parser";

function edit(text: string, from: number, to: number, action: CardAuthoringAction) {
  const change = cardAuthoringEdit(text, from, to, action);
  return { text: text.slice(0, change.from) + change.text + text.slice(change.to), cursor: change.cursor };
}
describe("quick card authoring", () => {
  it("inserts a review container without replacing a selected source passage", () => {
    const before = "原文不能丢失\n下一段";
    const after = edit(before, 0, 4, "review");
    expect(after.text).toContain("原文不能丢失\n\n> [!review]- 复习\n> \n\n下一段");
    expect(after.text.slice(after.cursor - 2, after.cursor)).toBe("> ");
  });
  it("inserts a body Q/A card after a container and positions the cursor after Q:", () => {
    const initial = edit("原文", 1, 1, "review");
    const after = edit(initial.text, initial.cursor, initial.cursor, "qa");
    expect(after.text.match(/\[!review\]/g)).toHaveLength(1);
    expect(after.text).toContain("Q: \nA: ");
    expect(after.text.slice(after.cursor - 3, after.cursor)).toBe("Q: ");
    expect(parseReviewCards(after.text).valid).toBe(false);
  });
  it("creates an independent container when the review button is pressed inside another one", () => {
    const before = "> [!review]- A\n> {{c1::文字}}\n";
    const after = edit(before, before.indexOf("文字"), before.indexOf("文字"), "review");
    expect(after.text.match(/\[!review\]/g)).toHaveLength(2);
    expect(parseReviewCallouts(after.text).cards).toHaveLength(1);
  });
  it("wraps selected words with context and produces a recognized cloze outside a callout", () => {
    const before = "前一段\n人体共有十二条经脉。\n后一段";
    const from = before.indexOf("十二"), after = edit(before, from, from + 2, "cloze");
    expect(after.text).toContain("人体共有{{c1::十二}}条经脉。");
    expect(after.text.startsWith("前一段\n")).toBe(true);
    expect(after.text.endsWith("\n后一段")).toBe(true);
    expect(parseReviewCards(after.text).cards[0].content.raw).toBe("前一段\n人体共有{{c1::十二}}条经脉。\n后一段");
  });
  it("adds another cloze within a review block without nesting or discarding text", () => {
    const before = "> [!review]\n> {{c1::甲}}和乙\n";
    const at = before.indexOf("乙"), after = edit(before, at, at + 1, "cloze");
    expect(after.text).toContain("{{c1::甲}}和{{c2::乙}}");
    expect(parseReviewCallouts(after.text).cards).toHaveLength(2);
    expect(() => edit(after.text, after.text.indexOf("甲"), after.text.indexOf("甲") + 1, "cloze")).toThrow("已经是填空");
  });
  it("preserves multiline selections inside a review block", () => {
    const before = "> [!review]\n> 第一行\n> 第二行\n";
    const after = edit(before, before.indexOf("第一"), before.indexOf("第二行") + 3, "cloze");
    expect(parseReviewCallouts(after.text).cards[0].content.raw).toBe("{{c1::第一行\n第二行}}");
  });
  it("refuses empty cloze selections and unsafe frontmatter, code or callout headers", () => {
    expect(() => edit("原文", 0, 0, "cloze")).toThrow("先选中");
    expect(() => edit("---\ntags: [review]\n---\n正文", 6, 6, "qa")).toThrow("属性");
    expect(() => edit("```\n正文\n```", 4, 6, "cloze")).toThrow("代码");
    expect(() => edit("> [!review]\n> 正文", 0, 12, "cloze")).toThrow("标题");
  });
  it("recognizes full-width QA separators and keeps unfinished QA from affecting existing cards", () => {
    const body = "> [!review]\n> 问：：问题\n> 答：：答案\n> ^rv-one\n";
    expect(parseReviewCallouts(body).cards[0]).toMatchObject({ blockId: "rv-one", content: { question: "问题", answer: "答案" } });
    const incomplete = body + ">\n> 问:: \n> 答:: 已写答案\n";
    expect(parseReviewCallouts(incomplete).valid).toBe(false);
    expect(parseReviewCallouts(incomplete).warnings.some((w) => w.includes("问题为空"))).toBe(true);
    expect(parseReviewCallouts(incomplete).cards[0].content.answer).toBe("答案");
  });

  it("inserts standard Basic and Cloze templates and rejects cloze inside Q/A content", () => {
    const basic = edit("正文", 2, 2, "standard-qa");
    expect(basic.text).toContain("START\nBasic\nFront: \nBack: \nEND");
    expect(basic.text.slice(basic.cursor - 7, basic.cursor)).toBe("Front: ");
    const cloze = edit("正文", 2, 2, "standard-cloze");
    expect(cloze.text).toContain("START\nCloze\nText: {{c1::}}\nExtra: \nEND");
    const qa = "Q: 问题\nA: 这里是答案\n";
    const from = qa.indexOf("答案");
    expect(() => edit(qa, from, from + 2, "cloze")).toThrow("另起一段");
    const incomplete = "Q: 尚未完成的问题\nA: \n";
    expect(() => edit(incomplete, 3, 7, "cloze")).toThrow("另起一段");
    const standard = "START\nBasic\nFront: 问题\nBack: 答案\nEND";
    expect(() => edit(standard, standard.indexOf("问题"), standard.indexOf("问题") + 2, "cloze")).toThrow("另起一段");
  });

  it("increments cloze numbers across a whole body paragraph and standard Cloze block", () => {
    const paragraph = "第一行 {{c1::甲}}\n第二行有乙";
    const body = edit(paragraph, paragraph.indexOf("乙"), paragraph.indexOf("乙") + 1, "cloze");
    expect(body.text).toContain("{{c2::乙}}");
    const standard = "START\nCloze\nText: {{c1::甲}}和乙\nExtra:\nEND";
    const updated = edit(standard, standard.indexOf("乙"), standard.indexOf("乙") + 1, "cloze");
    expect(updated.text).toContain("{{c2::乙}}");
  });
});
