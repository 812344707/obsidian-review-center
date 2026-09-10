import { pathIsInside } from "./utils";

export const EXERCISE_PAGE_MARKER = "<!-- review-center:exercise-page -->";
export const EXERCISE_PAGE_ID_PREFIX = "exercise-";
export const DEFAULT_EXERCISE_PAGE_FOLDER = "习题";
export const DEFAULT_EXERCISE_PAGE_NAME_TEMPLATE = "{{title}}-习题-{{date}}-{{time}}";

export interface ExercisePageSettings {
  exercisePageFolder: string;
  exercisePageNameTemplate: string;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

export function exercisePageVariables(now = new Date()): { date: string; time: string } {
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  };
}

function renderTimePattern(pattern: string, now: Date): string | undefined {
  if (!/(?:yyyy|MM|dd|HH|mm|ss)/.test(pattern)) return undefined;
  const remainder = pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, "");
  if (/[^ ._-]/.test(remainder)) return undefined;
  const values: Record<string, string> = {
    yyyy: String(now.getFullYear()), MM: pad(now.getMonth() + 1), dd: pad(now.getDate()),
    HH: pad(now.getHours()), mm: pad(now.getMinutes()), ss: pad(now.getSeconds()),
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => values[token]);
}

export function validateExercisePageFolder(value: string, dataFolder: string): string {
  const folder = value.trim().replace(/\/+$/, "");
  // eslint-disable-next-line no-control-regex -- Reject control characters in vault-relative paths.
  if (!folder || /^[\\/]|^[a-z]:/i.test(folder) || /[\\\u0000-\u001f]/.test(folder) ||
    folder.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[:*?"<>|]/.test(part) || /[. ]$/.test(part))) {
    throw new Error("习题文件夹须为知识库内的非隐藏子目录，例如 习题/医学；不能使用绝对路径或 ../。");
  }
  if (pathIsInside(folder, dataFolder)) {
    throw new Error("习题文件夹不能位于复习数据目录中。");
  }
  return folder;
}

function safeSourceTitle(title: string): string {
  // eslint-disable-next-line no-control-regex -- Replace filename characters invalid on common desktop and mobile platforms.
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[. ]+|[. ]+$/g, "").trim();
  return safe || "未命名";
}

export function renderExercisePageName(template: string, title: string, now = new Date()): string {
  let value = template.trim().replace(/\.md$/i, "");
  if (!value) throw new Error("文件名模板不能为空。");
  const unknown = [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1])
    .filter((name) => !["title", "date", "time"].includes(name) && renderTimePattern(name, now) === undefined);
  if (unknown.length) throw new Error(`不支持的文件名变量：{{${unknown[0]}}}。`);
  const variables = { title: safeSourceTitle(title), ...exercisePageVariables(now) };
  value = value.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) =>
    key in variables ? variables[key as keyof typeof variables] : renderTimePattern(key, now)!);
  // eslint-disable-next-line no-control-regex -- Reject literal template characters that cannot form a portable filename.
  if (/\{\{|\}\}|[\\/:*?"<>|\u0000-\u001f]/.test(value) || !value.trim() || /^[. ]/.test(value)) {
    throw new Error("文件名模板包含无效字符；可使用普通文字、{{title}}、{{date}}、{{time}} 或 {{yyyy-HHmm-ss}}。");
  }
  const normalized = value.replace(/[. ]+$/g, "").trim();
  if (!normalized) throw new Error("文件名模板生成了空文件名。");
  return normalized + ".md";
}

export function exercisePagePath(folder: string, filename: string, exists: (path: string) => boolean): string {
  const stem = filename.replace(/\.md$/i, "");
  let candidate = `${folder}/${stem}.md`;
  for (let suffix = 2; exists(candidate); suffix += 1) candidate = `${folder}/${stem}-${suffix}.md`;
  return candidate;
}

export function exercisePageMarkdown(tags: string[], sourceLink: string, reviewId: string): string {
  if (!reviewId.startsWith(EXERCISE_PAGE_ID_PREFIX)) throw new Error("习题页标识无效。");
  const normalizedTags = [...new Set(tags.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean))];
  const tagLine = normalizedTags.length ? `tags: ${JSON.stringify(normalizedTags)}\n` : "";
  return `---\nreview_id: ${reviewId}\n${tagLine}---\n\n来源：${sourceLink}\n\n# 习题\n\n`;
}

export function isExercisePage(markdown: string): boolean {
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? "";
  return /^review_id:\s*exercise-[a-z0-9_-]+\s*$/im.test(frontmatter) ||
    new RegExp(`^${EXERCISE_PAGE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(markdown);
}
