import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import {
  analyzeAutoQuestionBank,
  appendAutoQuestionBatch,
  assertSafeApiTransport,
  autoQuestionBankMarkdown,
  buildAutoQuestionRequest,
  decideAutoQuestionAction,
  DEFAULT_AUTO_QUESTION_PROMPT,
  isAutoQuestionFrontmatter,
  parseAutoQuestionResponse,
  renderAutoQuestionPrompt,
  validateAutoQuestionEndpoint,
  validateAutoQuestionFolder,
} from "../src/auto-question";
import { normalizeSettings } from "../src/config";
import { parseReviewCards } from "../src/parser";
import type { HistoryEvent, ReviewItem, SourceRecord } from "../src/types";
import { fixtureItem, fixtureRecord, reviewEvent, today } from "./fixtures";

function bankRecord(...questions: string[]): SourceRecord {
  const record = fixtureRecord("exercise-bank", ["#card"]);
  record.sourcePath = "自动题库/原文-自动题库.md";
  record.cards = Object.fromEntries(questions.map((question, index) => {
    const item = fixtureItem(`rv-${index + 1}:qa`);
    item.content.question = question;
    return [item.id, item];
  }));
  return record;
}

function rating(record: SourceRecord, item: ReviewItem, value: number, id: string, at = today): HistoryEvent {
  const event = reviewEvent(id, record.reviewId, "card", at, item.revision);
  event.itemId = item.id;
  event.rating = value;
  event.after = structuredClone(item);
  return event;
}

describe("automatic question decisions", () => {
  const settings = normalizeSettings(null).autoQuestion;

  it("generates an initial batch, waits for unanswered cards, continues below mastery and stops at mastery", () => {
    expect(decideAutoQuestionAction(analyzeAutoQuestionBank([], []), settings))
      .toEqual({ kind: "generate", reason: "initial", count: 5 });

    const record = bankRecord("第一题", "第二题");
    const cards = Object.values(record.cards);
    const first = rating(record, cards[0], 3, "first");
    expect(decideAutoQuestionAction(analyzeAutoQuestionBank([record], [first]), settings))
      .toEqual({ kind: "wait", reason: "unanswered" });

    const hard = rating(record, cards[1], 2, "second");
    const weak = analyzeAutoQuestionBank([record], [first, hard]);
    expect(weak).toMatchObject({ answeredQuestions: 2, masteredQuestions: 1, masteryRate: 0.5, weakQuestions: ["第二题"] });
    expect(decideAutoQuestionAction(weak, settings))
      .toEqual({ kind: "generate", reason: "below-mastery", count: 5 });

    hard.rating = 4;
    expect(decideAutoQuestionAction(analyzeAutoQuestionBank([record], [first, hard]), settings))
      .toEqual({ kind: "stop", reason: "mastered" });
  });

  it("waits for changed cards, honors resets, ignores removed cards and enforces the total limit", () => {
    const record = bankRecord("第一题", "第二题", "移除题");
    const cards = Object.values(record.cards);
    cards[1].status = "pending-change";
    cards[2].status = "removed";
    expect(decideAutoQuestionAction(analyzeAutoQuestionBank([record], []), settings))
      .toEqual({ kind: "wait", reason: "pending-change" });

    cards[1].status = "active";
    const reviewed = rating(record, cards[0], 3, "reviewed", new Date("2026-09-03T01:00:00Z"));
    const reset = { ...reviewed, eventId: "reset", action: "reset" as const, occurredAt: "2026-09-03T02:00:00Z", rating: undefined };
    expect(analyzeAutoQuestionBank([record], [reviewed, reset]).answeredQuestions).toBe(0);

    const capped = { ...settings, maxQuestions: 2 };
    expect(decideAutoQuestionAction(analyzeAutoQuestionBank([record], []), capped))
      .toEqual({ kind: "stop", reason: "limit" });
  });
});

describe("automatic question API contract", () => {
  const settings = normalizeSettings({ autoQuestion: { model: "study-model" } }).autoQuestion;

  it("renders supported prompt variables and rejects unknown placeholders", () => {
    const prompt = renderAutoQuestionPrompt(DEFAULT_AUTO_QUESTION_PROMPT, {
      sourceTitle: "股骨假体", sourcePath: "资料/股骨假体.md", sourceContent: "原文内容",
      questionCount: 3, masteryRate: 0.5, weakQuestions: ["薄弱题"], existingQuestions: ["旧题"],
    });
    expect(prompt).toContain("本次出题数：3");
    expect(prompt).toContain("当前掌握率：50%");
    expect(prompt).toContain("1. 薄弱题");
    expect(() => renderAutoQuestionPrompt("{{unknown}}", {
      sourceTitle: "", sourcePath: "", sourceContent: "", questionCount: 1,
      masteryRate: 0, weakQuestions: [], existingQuestions: [],
    })).toThrow("不支持的变量");
  });

  it("builds Responses and Chat Completions structured-output requests without persisting a secret", () => {
    const responses = buildAutoQuestionRequest(settings, "secret-value", "prompt");
    expect(responses.headers.Authorization).toBe("Bearer secret-value");
    expect(responses.body).toMatchObject({ model: "study-model", store: false, text: { format: { type: "json_schema", strict: true } } });

    const chat = buildAutoQuestionRequest({
      ...settings, apiFormat: "chat-completions", endpoint: "https://gateway.example/v1/chat/completions",
    }, null, "prompt");
    expect(chat.headers).not.toHaveProperty("Authorization");
    expect(chat.body).toMatchObject({ response_format: { type: "json_schema" } });
    expect(normalizeSettings({ autoQuestion: { apiKeySecret: "my-key" } }).autoQuestion).toMatchObject({ apiKeySecret: "my-key" });
    expect(JSON.stringify(normalizeSettings({ autoQuestion: { apiKeySecret: "my-key" } }))).not.toContain("secret-value");
  });

  it("parses both response formats, removes duplicates and validates transport and stored settings", () => {
    const payload = JSON.stringify({ questions: [
      { question: "新题？", answer: "答案", explanation: "依据" },
      { question: "旧 题！", answer: "重复", explanation: "重复" },
    ] });
    expect(parseAutoQuestionResponse("responses", { output: [{ content: [{ type: "output_text", text: payload }] }] }, 5, ["旧题"]))
      .toEqual([{ question: "新题？", answer: "答案", explanation: "依据" }]);
    expect(parseAutoQuestionResponse("chat-completions", { choices: [{ message: { content: payload } }] }, 1))
      .toHaveLength(1);
    expect(validateAutoQuestionEndpoint("https://api.example/v1/responses")).toBe("https://api.example/v1/responses");
    expect(() => assertSafeApiTransport("http://api.example/v1")).toThrow("HTTPS");
    expect(() => assertSafeApiTransport("http://127.0.0.1:11434/v1/chat/completions")).not.toThrow();
    expect(validateAutoQuestionFolder("题库/骨科/", "复习中心数据")).toBe("题库/骨科");
    expect(() => validateAutoQuestionFolder("复习中心数据/题库", "复习中心数据")).toThrow();

    const normalized = normalizeSettings({ autoQuestion: { endpoint: "http://api.example/v1", outputFolder: "../题库", prompt: "{{bad}}" } });
    expect(normalized.autoQuestion.endpoint).toBe("https://api.openai.com/v1/responses");
    expect(normalized.autoQuestion.outputFolder).toBe("自动题库");
    expect(normalized.autoQuestion.prompt).toBe(DEFAULT_AUTO_QUESTION_PROMPT);
  });
});

describe("automatic question Markdown", () => {
  const questions = [
    { question: "什么是松动？", answer: "第一行\n\n第二行", explanation: "依据原文。" },
    { question: "如何判断？", answer: "结合影像。", explanation: "只考一个知识点。" },
  ];

  it("creates and appends parser-valid review callouts with durable source identity", () => {
    const first = autoQuestionBankMarkdown({
      sourcePath: "资料/原文.md", sourceLink: "[[资料/原文|原文]]", sourceTitle: "原文",
      tags: ["#card", "card"], questions, now: new Date("2026-09-20T08:00:00"), reviewId: "exercise-auto-one",
    });
    const parsed = parseReviewCards(first);
    expect(parsed.valid).toBe(true);
    expect(parsed.cards).toHaveLength(2);
    expect(new Set(parsed.cards.map((card) => card.blockId)).size).toBe(2);
    expect(first).toContain('auto_question_source: "资料/原文.md"');
    expect(first).toContain('tags: ["card"]');

    const appended = appendAutoQuestionBatch(first, [questions[0]], 2, new Date("2026-09-20T09:00:00"));
    expect(parseReviewCards(appended).cards).toHaveLength(3);
    expect(appended).toContain("## 批次 2");
    expect(isAutoQuestionFrontmatter({ review_center_auto_questions: true, auto_question_source: "资料/原文.md" }, "资料/原文.md")).toBe(true);
  });
});
