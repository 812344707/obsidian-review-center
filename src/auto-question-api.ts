import { requestUrl } from "obsidian";
import {
  buildAutoQuestionRequest,
  parseAutoQuestionResponse,
  type GeneratedQuestion,
} from "./auto-question";
import type { AutoQuestionSettings } from "./types";

export async function requestAutoQuestions(
  settings: AutoQuestionSettings,
  apiKey: string | null,
  prompt: string,
  expectedCount: number,
  existingQuestions: string[],
): Promise<GeneratedQuestion[]> {
  const request = buildAutoQuestionRequest(settings, apiKey, prompt);
  const response = await requestUrl({
    url: request.url,
    method: "POST",
    headers: request.headers,
    contentType: "application/json",
    body: JSON.stringify(request.body),
    throw: false,
  });
  const json = responseJson(response);
  if (response.status < 200 || response.status >= 300) {
    const detail = apiErrorMessage(json, response.text);
    throw new Error(`大模型 API 返回 ${response.status}${detail ? `：${detail}` : ""}`);
  }
  return parseAutoQuestionResponse(settings.apiFormat, json, expectedCount, existingQuestions);
}

function responseJson(response: { json: unknown }): unknown {
  try { return response.json; }
  catch { throw new Error("大模型 API 返回的正文不是有效 JSON。"); }
}

function apiErrorMessage(json: unknown, text: string): string {
  if (isObject(json) && isObject(json.error) && typeof json.error.message === "string") {
    return json.error.message.slice(0, 500);
  }
  return text.trim().slice(0, 500);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
