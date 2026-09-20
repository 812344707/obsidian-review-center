import { effectiveReviews } from "./activity";
import { parseReviewCards } from "./parser";
import type {
  AutoQuestionApiFormat,
  AutoQuestionSettings,
  HistoryEvent,
  SourceRecord,
} from "./types";
import { createId, hashText } from "./utils";

export const DEFAULT_AUTO_QUESTION_PROMPT = `你是严谨的学习出题助手。题目必须只依据原文，不得编造原文未包含的事实。

原文标题：{{source_title}}
原文路径：{{source_path}}
本次出题数：{{question_count}}
当前掌握率：{{mastery_percent}}

当前薄弱题目（优先变换角度再练习，不要原句重复）：
{{weak_questions}}

已有题目（严禁直接或同义重复）：
{{existing_questions}}

原文：
{{source_content}}

每题只考一个清晰知识点；答案要能直接用于自我检查；explanation 用一两句说明答案依据。`;

export const DEFAULT_AUTO_QUESTION_SETTINGS: AutoQuestionSettings = {
  enabled: false,
  apiFormat: "responses",
  endpoint: "https://api.openai.com/v1/responses",
  model: "",
  apiKeySecret: "",
  prompt: DEFAULT_AUTO_QUESTION_PROMPT,
  outputFolder: "自动题库",
  tags: ["review"],
  batchSize: 5,
  masteryThreshold: 0.9,
  maxQuestions: 50,
  maxSourceCharacters: 30_000,
};

export interface GeneratedQuestion {
  question: string;
  answer: string;
  explanation: string;
}

export interface AutoQuestionBankStats {
  totalQuestions: number;
  activeQuestions: number;
  answeredQuestions: number;
  masteredQuestions: number;
  pendingChanges: number;
  masteryRate: number;
  existingQuestions: string[];
  weakQuestions: string[];
  fingerprint: string;
}

export type AutoQuestionDecision =
  | { kind: "generate"; reason: "initial" | "below-mastery"; count: number }
  | { kind: "wait"; reason: "unanswered" | "pending-change" | "no-active" }
  | { kind: "stop"; reason: "mastered" | "limit" };

export interface AutoQuestionPromptContext {
  sourceTitle: string;
  sourcePath: string;
  sourceContent: string;
  questionCount: number;
  masteryRate: number;
  weakQuestions: string[];
  existingQuestions: string[];
}

export interface AutoQuestionRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const OUTPUT_CONTRACT = [
  "只返回 JSON 对象，不要 Markdown 代码块或其他文字。",
  '格式为 {"questions":[{"question":"...","answer":"...","explanation":"..."}]}。',
  "question 必须是单行文字，answer 和 explanation 可包含 Markdown。",
].join("\n");

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["question", "answer", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

export function validateAutoQuestionFolder(value: string, dataFolder: string): string {
  const folder = value.trim().replace(/\/+$/, "");
  // eslint-disable-next-line no-control-regex -- Reject control characters in vault-relative paths.
  if (!folder || /^[\\/]|^[a-z]:/i.test(folder) || /[\\\u0000-\u001f]/.test(folder) ||
    folder.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|]/.test(part) || /[. ]$/.test(part))) {
    throw new Error("自动题库文件夹须为知识库内的非隐藏子目录，例如 题库/骨科；不能使用绝对路径或 ../。");
  }
  const base = dataFolder.replace(/^\/+|\/+$/g, "");
  if (folder === base || folder.startsWith(base + "/")) throw new Error("自动题库不能位于复习数据目录中。");
  return folder;
}

export function validateAutoQuestionEndpoint(value: string): string {
  const endpoint = value.trim();
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("请输入完整的 API 地址，例如 https://api.openai.com/v1/responses。"); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Error("API 地址仅支持 http/https，且不得在网址中嵌入账号、密码或片段。");
  }
  return url.toString();
}

export function assertSafeApiTransport(endpoint: string): void {
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("非本机 API 地址必须使用 HTTPS，以免学习内容和密钥明文传输。");
  }
}

export function analyzeAutoQuestionBank(records: SourceRecord[], history: HistoryEvent[]): AutoQuestionBankStats {
  const cards = records.flatMap((record) => Object.values(record.cards).map((card) => ({ record, card })))
    .filter(({ card }) => card.status !== "removed");
  const active = cards.filter(({ card }) => card.status === "active");
  const pendingChanges = cards.filter(({ card }) => card.status === "pending-change").length;
  const keys = new Set(active.map(({ record, card }) => `${record.reviewId}::${card.id}`));
  const resets = new Map<string, number>();
  for (const event of history) {
    if (event.action !== "reset" && event.action !== "change-reset") continue;
    const key = `${event.sourceId}::${event.itemId}`;
    if (!keys.has(key)) continue;
    resets.set(key, Math.max(resets.get(key) ?? 0, new Date(event.occurredAt).getTime()));
  }
  const latest = new Map<string, HistoryEvent>();
  for (const event of effectiveReviews(history)) {
    const key = `${event.sourceId}::${event.itemId}`;
    if (!keys.has(key) || new Date(event.occurredAt).getTime() <= (resets.get(key) ?? -Infinity)) continue;
    latest.set(key, event);
  }
  const answered = active.filter(({ record, card }) => latest.has(`${record.reviewId}::${card.id}`));
  const mastered = answered.filter(({ record, card }) => (latest.get(`${record.reviewId}::${card.id}`)?.rating ?? 0) >= 3);
  const weakQuestions = answered.filter(({ record, card }) => (latest.get(`${record.reviewId}::${card.id}`)?.rating ?? 0) <= 2)
    .map(({ card }) => card.content.question);
  const fingerprintRows = cards.map(({ record, card }) => {
    const event = latest.get(`${record.reviewId}::${card.id}`);
    return [record.reviewId, card.id, card.revision, card.status, event?.eventId ?? ""];
  });
  return {
    totalQuestions: cards.length,
    activeQuestions: active.length,
    answeredQuestions: answered.length,
    masteredQuestions: mastered.length,
    pendingChanges,
    masteryRate: active.length ? mastered.length / active.length : 0,
    existingQuestions: cards.map(({ card }) => card.content.question),
    weakQuestions,
    fingerprint: hashText(JSON.stringify(fingerprintRows)),
  };
}

export function decideAutoQuestionAction(stats: AutoQuestionBankStats, settings: AutoQuestionSettings): AutoQuestionDecision {
  if (stats.pendingChanges > 0) return { kind: "wait", reason: "pending-change" };
  if (stats.totalQuestions >= settings.maxQuestions) return { kind: "stop", reason: "limit" };
  if (stats.totalQuestions === 0) return { kind: "generate", reason: "initial", count: Math.min(settings.batchSize, settings.maxQuestions) };
  if (stats.activeQuestions === 0) return { kind: "wait", reason: "no-active" };
  if (stats.answeredQuestions < stats.activeQuestions) return { kind: "wait", reason: "unanswered" };
  if (stats.masteryRate >= settings.masteryThreshold) return { kind: "stop", reason: "mastered" };
  return { kind: "generate", reason: "below-mastery", count: Math.min(settings.batchSize, settings.maxQuestions - stats.totalQuestions) };
}

export function renderAutoQuestionPrompt(template: string, context: AutoQuestionPromptContext): string {
  const values: Record<string, string> = {
    source_title: context.sourceTitle,
    source_path: context.sourcePath,
    source_content: context.sourceContent,
    question_count: String(context.questionCount),
    mastery_percent: `${Math.round(context.masteryRate * 100)}%`,
    weak_questions: listQuestions(context.weakQuestions),
    existing_questions: listQuestions(context.existingQuestions),
  };
  const unknown = [...template.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]).find((key) => !(key in values));
  if (unknown) throw new Error(`提示词包含不支持的变量：{{${unknown}}}。`);
  const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => values[key]);
  if (!rendered.trim()) throw new Error("自动出题提示词不能为空。");
  return rendered.trim();
}

export function buildAutoQuestionRequest(
  settings: AutoQuestionSettings,
  apiKey: string | null,
  prompt: string,
): AutoQuestionRequest {
  const url = validateAutoQuestionEndpoint(settings.endpoint);
  assertSafeApiTransport(url);
  if (!settings.model.trim()) throw new Error("请先设置自动出题模型名称。");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const format = { type: "json_schema", name: "review_questions", strict: true, schema: QUESTION_SCHEMA };
  const body = settings.apiFormat === "responses" ? {
    model: settings.model.trim(),
    store: false,
    input: `${prompt}\n\n${OUTPUT_CONTRACT}`,
    text: { format },
  } : {
    model: settings.model.trim(),
    messages: [
      { role: "system", content: OUTPUT_CONTRACT },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_schema", json_schema: { name: format.name, strict: true, schema: format.schema } },
  };
  return { url, headers, body };
}

export function parseAutoQuestionResponse(
  format: AutoQuestionApiFormat,
  response: unknown,
  expectedCount: number,
  existingQuestions: string[] = [],
): GeneratedQuestion[] {
  const text = format === "responses" ? responsesText(response) : chatCompletionText(response);
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonFence(text)); }
  catch { throw new Error("大模型未返回可解析的 JSON 题目。"); }
  if (!isObject(parsed) || !Array.isArray(parsed.questions)) throw new Error("大模型返回缺少 questions 数组。");
  const seen = new Set(existingQuestions.map(questionKey));
  const result: GeneratedQuestion[] = [];
  for (const value of parsed.questions) {
    if (!isObject(value)) continue;
    const question = plainQuestion(value.question);
    const answer = plainField(value.answer, "答案", 8_000).replace(/^\s*答[:：]{2}\s*/, "");
    const explanation = plainField(value.explanation, "解析", 8_000);
    if (!question || !answer) continue;
    const key = questionKey(question);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ question, answer, explanation });
    if (result.length >= expectedCount) break;
  }
  if (!result.length) throw new Error("大模型返回的题目均为空、重复或超出长度限制，未写入题库。");
  return result;
}

export function autoQuestionBankMarkdown(options: {
  sourcePath: string;
  sourceLink: string;
  sourceTitle: string;
  tags: string[];
  questions: GeneratedQuestion[];
  now?: Date;
  reviewId?: string;
}): string {
  const now = options.now ?? new Date();
  const normalizedTags = [...new Set(options.tags.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean))];
  const reviewId = options.reviewId ?? createId("exercise");
  const batch = autoQuestionBatchMarkdown(options.questions, 1, now);
  const markdown = `---\nreview_id: ${reviewId}\ntags: ${JSON.stringify(normalizedTags)}\nreview_center_auto_questions: true\nauto_question_source: ${JSON.stringify(options.sourcePath)}\nauto_question_version: 1\n---\n\n# ${options.sourceTitle}·自动题库\n\n来源：${options.sourceLink}\n\n${batch}`;
  assertGeneratedMarkdown(markdown, options.questions.length);
  return markdown;
}

export function appendAutoQuestionBatch(markdown: string, questions: GeneratedQuestion[], batchNumber: number, now = new Date()): string {
  const separator = markdown.endsWith("\n") ? "\n" : "\n\n";
  const result = markdown + separator + autoQuestionBatchMarkdown(questions, batchNumber, now);
  const parsed = parseReviewCards(result);
  if (!parsed.valid) throw new Error("生成的题库格式校验失败：" + parsed.warnings.join("；"));
  return result;
}

export function isAutoQuestionFrontmatter(frontmatter: unknown, sourcePath?: string): boolean {
  if (!isObject(frontmatter) || frontmatter.review_center_auto_questions !== true) return false;
  return sourcePath === undefined || frontmatter.auto_question_source === sourcePath;
}

function autoQuestionBatchMarkdown(questions: GeneratedQuestion[], batchNumber: number, now: Date): string {
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const cards = questions.map((question, index) => {
    const answer = quoteField("答::", question.answer);
    const extra = question.explanation ? quoteField("Extra:", question.explanation) : [];
    return [
      `> [!review]+ 自动出题 ${batchNumber}.${index + 1}`,
      `> 问:: ${question.question}`,
      ...answer,
      ...extra,
      `> ^${createId("rv")}`,
    ].join("\n");
  }).join("\n\n");
  return `## 批次 ${batchNumber} · ${timestamp}\n\n${cards}\n`;
}

function quoteField(label: string, value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").trim().split("\n");
  return [`> ${label} ${lines[0]}`, ...lines.slice(1).map((line) => `> ${line}`)];
}

function assertGeneratedMarkdown(markdown: string, expected: number): void {
  const parsed = parseReviewCards(markdown);
  if (!parsed.valid || parsed.cards.length !== expected) {
    throw new Error("生成的题库格式校验失败" + (parsed.warnings.length ? `：${parsed.warnings.join("；")}` : "。"));
  }
}

function responsesText(response: unknown): string {
  if (!isObject(response)) throw new Error("大模型响应不是有效对象。");
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const texts: string[] = [];
  if (Array.isArray(response.output)) for (const item of response.output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) if (isObject(content) && content.type === "output_text" && typeof content.text === "string") texts.push(content.text);
  }
  if (!texts.length) throw new Error("大模型响应中没有 output_text。");
  return texts.join("");
}

function chatCompletionText(response: unknown): string {
  if (!isObject(response) || !isUnknownArray(response.choices)) throw new Error("大模型响应中没有 choices。");
  const first = response.choices[0];
  if (!isObject(first) || !isObject(first.message)) throw new Error("大模型响应中没有 message。");
  const content = first.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.filter(isObject).map((item) => typeof item.text === "string" ? item.text : "").join("");
    if (text) return text;
  }
  throw new Error("大模型响应中没有文本内容。");
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1] : trimmed;
}

function plainQuestion(value: unknown): string {
  if (typeof value !== "string") return "";
  const question = value.replace(/^\s*问[:：]{2}\s*/, "").replace(/\s+/g, " ").trim();
  return question.length <= 1_000 ? question : "";
}

function plainField(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > maximum) throw new Error(`大模型返回的${name}过长，未写入题库。`);
  return text;
}

function questionKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function listQuestions(values: string[]): string {
  return values.length ? values.map((value, index) => `${index + 1}. ${value}`).join("\n") : "（暂无）";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
