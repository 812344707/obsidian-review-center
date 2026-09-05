import type { RecognitionFilter, RecognitionRule, ReviewGroup } from "./types";

const tagValue = (value: string) => value.trim().replace(/^#+/, "").toLowerCase();
export function validateRecognition(filter: RecognitionFilter): RecognitionFilter {
  if (!["all", "any"].includes(filter.match) || !Array.isArray(filter.rules)) throw new Error("识别条件格式无效。");
  return { match: filter.match, rules: filter.rules.map((r) => {
    if (!r || !["folder", "tag"].includes(r.field) || !["is", "is-not", "contains", "excludes"].includes(r.operator) || typeof r.value !== "string") throw new Error("识别条件格式无效。");
    const value = r.field === "tag" ? tagValue(r.value) : r.value.trim().replace(/\/$/, "") || (r.value.trim() === "/" ? "/" : "");
    if (!value) throw new Error("请填写每条条件的文件夹或标签，或删除空条件。");
    if (r.field === "tag" && (!/^[\p{L}\p{M}\p{N}_/-]+$/u.test(value) || value.split("/").some((p) => !p) || /^\d+$/.test(value))) throw new Error("请输入一个有效标签，例如 review/伤寒。");
    if (r.field === "folder" && value !== "/" && (/^[\\/]|^[a-z]:|[\\\u0000-\u001f]/i.test(value) || value.split("/").some((p) => !p || p === "." || p === ".."))) throw new Error("文件夹须为知识库内相对路径；根目录填 /。");
    return { ...r, value };
  }) };
}

/** Invalid persisted conditions must never silently widen a review scope. */
export function normalizeRecognition(value: unknown): RecognitionFilter | undefined {
  if (value === undefined) return undefined;
  try { return validateRecognition(value as RecognitionFilter); }
  catch { return { match: "all", rules: [] }; }
}

export function groupFilter(group: ReviewGroup): RecognitionFilter {
  return group.recognition ?? { match: "any", rules: group.tags.map((value) => ({ field: "tag", operator: "contains", value })) };
}

export function matchesRule(tags: string[], path: string, rule: RecognitionRule): boolean {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
  const values = rule.field === "tag" ? tags.map(tagValue) : path ? [folder] : [];
  const value = rule.field === "tag" ? tagValue(rule.value) : rule.value;
  const nested = rule.operator === "contains" || rule.operator === "excludes";
  const found = values.some((actual) => actual === value || (nested && (rule.field === "folder" && value === "/" || actual.startsWith(value + "/"))));
  return rule.operator === "is-not" || rule.operator === "excludes" ? !found : found;
}

export function recognitionPriority(tags: string[], path: string, group: ReviewGroup): number {
  const filter = groupFilter(group);
  if (!filter.rules.length) return 0;
  const match = filter.rules.map((rule) => matchesRule(tags, path, rule));
  if (!(filter.match === "all" ? match.every(Boolean) : match.some(Boolean))) return 0;
  return Math.max(1, ...filter.rules.map((r, i) => match[i] && (r.operator === "is" || r.operator === "contains") ? r.value.split("/").length : 0));
}

export function recognitionTags(group: ReviewGroup): string[] {
  return [...new Set(groupFilter(group).rules.filter((r) => r.field === "tag" && (r.operator === "is" || r.operator === "contains")).map((r) => tagValue(r.value)))];
}
