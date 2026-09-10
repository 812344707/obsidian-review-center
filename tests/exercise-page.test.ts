import { describe, expect, it } from "vitest";
import {
  EXERCISE_PAGE_MARKER,
  exercisePageMarkdown,
  exercisePagePath,
  exercisePageVariables,
  isExercisePage,
  renderExercisePageName,
  validateExercisePageFolder,
} from "../src/exercise-page";
import { parseReviewCards } from "../src/parser";

describe("exercise page naming and content", () => {
  const now = new Date(2026, 8, 10, 14, 30, 25);

  it("renders every supported filename variable with local date and time", () => {
    expect(exercisePageVariables(now)).toEqual({ date: "2026-09-10", time: "143025" });
    expect(renderExercisePageName("{{title}}-习题-{{date}}-{{time}}", "伤寒论", now))
      .toBe("伤寒论-习题-2026-09-10-143025.md");
    expect(renderExercisePageName("{{date}} {{title}}.md", "原文", now)).toBe("2026-09-10 原文.md");
    expect(renderExercisePageName("{{title}}-{{yyyy-HHmm-ss}}", "伤寒论", now))
      .toBe("伤寒论-2026-1430-25.md");
    expect(renderExercisePageName("{{yyyy}}-{{MM}}{{dd}}-{{HH}}{{mm}}{{ss}}", "原文", now))
      .toBe("2026-0910-143025.md");
  });

  it("sanitizes source titles but rejects invalid templates and variables", () => {
    expect(renderExercisePageName("{{title}}-{{time}}", "方剂/A:B?", now)).toBe("方剂-A-B--143025.md");
    for (const template of ["", "{{unknown}}", "{{title}}/习题", "{{title", ".{{title}}"])
      expect(() => renderExercisePageName(template, "原文", now)).toThrow();
  });

  it("validates non-hidden vault folders outside the data directory", () => {
    expect(validateExercisePageFolder(" 习题/医学/ ", "复习中心数据")).toBe("习题/医学");
    for (const folder of ["", "/习题", "../习题", "习题/.缓存", "习题/非法:目录", "复习中心数据/习题", "复习中心数据"])
      expect(() => validateExercisePageFolder(folder, "复习中心数据")).toThrow();
  });

  it("increments duplicate filenames without overwriting", () => {
    const existing = new Set(["习题/原文.md", "习题/原文-2.md"]);
    expect(exercisePagePath("习题", "原文.md", (path) => existing.has(path))).toBe("习题/原文-3.md");
  });

  it("copies unique tags, links the source and retains a persistent marker", () => {
    const markdown = exercisePageMarkdown(["#医学/伤寒", "#医学/伤寒", "#复习"], "[[原文]]", "exercise-page-one");
    expect(markdown).toContain('tags: ["医学/伤寒","复习"]');
    expect(markdown).toContain("review_id: exercise-page-one");
    expect(markdown).not.toContain(EXERCISE_PAGE_MARKER);
    expect(markdown).toContain("来源：[[原文]]\n\n# 习题\n\n");
    expect(isExercisePage(markdown)).toBe(true);
    expect(isExercisePage(`${EXERCISE_PAGE_MARKER}\n旧习题页`)).toBe(true);
    expect(isExercisePage("普通笔记")).toBe(false);
  });

  it("keeps existing question, cloze and review callout recognition on the new page", () => {
    const markdown = exercisePageMarkdown(["#复习"], "[[原文]]", "exercise-page-two") + [
      "Q: 简写问题", "A: 简写答案", "", "独立 {{c1::填空}} 段落", "",
      "> [!review]+ Callout 问题", "> 问:: Callout 问题", "> 答:: Callout 答案", "",
    ].join("\n");
    const parsed = parseReviewCards(markdown);
    expect(parsed.valid).toBe(true);
    expect(parsed.cards.map((card) => card.kind)).toEqual(["qa", "cloze", "qa"]);
  });
});
