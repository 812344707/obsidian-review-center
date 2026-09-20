import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl: mocks.requestUrl }));

import { requestAutoQuestions } from "../src/auto-question-api";
import { normalizeSettings } from "../src/config";

describe("automatic question request execution", () => {
  beforeEach(() => mocks.requestUrl.mockReset());

  it("posts structured JSON and returns validated questions", async () => {
    mocks.requestUrl.mockResolvedValue({
      status: 200,
      json: { output_text: JSON.stringify({ questions: [{ question: "问题", answer: "答案", explanation: "依据" }] }) },
      text: "",
    });
    const settings = normalizeSettings({ autoQuestion: { model: "study-model" } }).autoQuestion;
    await expect(requestAutoQuestions(settings, "api-key", "prompt", 1, [])).resolves.toEqual([
      { question: "问题", answer: "答案", explanation: "依据" },
    ]);
    expect(mocks.requestUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer api-key" }),
      throw: false,
    }));
  });

  it("reports provider errors without writing any result", async () => {
    mocks.requestUrl.mockResolvedValue({ status: 429, json: { error: { message: "rate limited" } }, text: "" });
    const settings = normalizeSettings({ autoQuestion: { model: "study-model" } }).autoQuestion;
    await expect(requestAutoQuestions(settings, null, "prompt", 1, [])).rejects.toThrow("429：rate limited");
  });
});
