import { getAllTags, getFrontMatterInfo, parseYaml, stringifyYaml, type App } from "obsidian";
import { normalizeTags, parseTags } from "./config";
import type { ReviewCenterSettings } from "./types";
import { pathIsInside } from "./utils";

export function matchesTags(actual: string[], targets: string[], match: "any" | "all" = "any"): boolean {
  const values = normalizeTags(actual);
  const wanted = normalizeTags(targets);
  if (!wanted.length) return false;
  const has = (tag: string) => values.some((value) => value === tag || value.startsWith(tag + "/"));
  return match === "all" ? wanted.every(has) : wanted.some(has);
}

export function collectVaultTags(app: App): string[] {
  const tags = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    for (const tag of normalizeTags(getAllTags(app.metadataCache.getFileCache(file) ?? {}) ?? [])) {
      const parts = tag.split("/");
      for (let count = 1; count <= parts.length; count += 1) tags.add(parts.slice(0, count).join("/"));
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export interface BulkTagRequest {
  target: "folder" | "tags";
  folder: string;
  recursive: boolean;
  tags: string[];
  match: "any" | "all";
  additions: string[];
}
export interface BulkTagPreview {
  path: string;
  original: string;
  knownTags: string[];
  additions: string[];
  selected: boolean;
  error?: string;
}
export interface BulkTagResult { path: string; status: "added" | "unchanged" | "failed"; message: string }

export function matchesFolder(path: string, folder: string, recursive: boolean): boolean {
  const normalized = folder.replace(/^\/+|\/+$/g, "");
  if (normalized && !pathIsInside(path, normalized)) return false;
  return recursive || path.slice(0, Math.max(0, path.lastIndexOf("/"))) === normalized;
}

function propertyTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(/[\s,，]+/).filter(Boolean);
  if (Array.isArray(value) && value.every((tag) => typeof tag === "string")) return value;
  throw new Error("tags 属性不是文字或文字列表，已跳过，原内容保留。");
}

export function appendTags(markdown: string, additions: string[], knownTags: string[]): string {
  const info = getFrontMatterInfo(markdown);
  if (/^(?:\uFEFF)?---\r?\n/.test(markdown) && !info.exists) throw new Error("笔记属性没有正确结束，已跳过。");
  let parsed: unknown;
  try { parsed = info.exists ? parseYaml(info.frontmatter) : {}; }
  catch { throw new Error("笔记开头的属性无法解析，请检查标签、缩进和括号；原内容保留。"); }
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("笔记属性格式不正确，已跳过。");
  const frontmatter = { ...(parsed ?? {}) } as Record<string, unknown>;
  const previous = propertyTags(frontmatter.tags);
  const existing = new Set(normalizeTags([...previous, ...knownTags]));
  const missing = parseTags(additions.join(" ")).filter((tag) => !existing.has(tag));
  if (!missing.length) return markdown;
  frontmatter.tags = [...previous, ...missing];
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const yaml = stringifyYaml(frontmatter).replace(/\r?\n/g, newline);
  if (info.exists) return markdown.slice(0, info.from) + yaml + markdown.slice(info.to);
  return "---" + newline + yaml + "---" + newline + markdown;
}

function matchesRequest(path: string, tags: string[], request: BulkTagRequest): boolean {
  return request.target === "folder" ? matchesFolder(path, request.folder, request.recursive) : matchesTags(tags, request.tags, request.match);
}

export async function previewBulkTags(app: App, settings: ReviewCenterSettings, request: BulkTagRequest): Promise<BulkTagPreview[]> {
  const additions = parseTags(request.additions.join(" "));
  if (!additions.length) throw new Error("请先填写要新增的标签。");
  if (request.target === "tags" && !request.tags.length) throw new Error("请先选择用于筛选的标签。");
  const result: BulkTagPreview[] = [];
  for (const file of app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))) {
    if (pathIsInside(file.path, settings.dataFolder)) continue;
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) throw new Error("标签索引尚未完成，请稍后重新预览。");
    const knownTags = getAllTags(cache) ?? [];
    if (!matchesRequest(file.path, knownTags, request)) continue;
    const entry: BulkTagPreview = { path: file.path, original: "", knownTags, additions: [], selected: true };
    try {
      entry.original = await app.vault.read(file);
      const known = new Set(normalizeTags(knownTags));
      entry.additions = additions.filter((tag) => !known.has(tag));
      appendTags(entry.original, additions, knownTags);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.selected = false;
    }
    result.push(entry);
  }
  return result;
}

export async function applyBulkTags(app: App, settings: ReviewCenterSettings, request: BulkTagRequest, preview: BulkTagPreview[]): Promise<BulkTagResult[]> {
  const results: BulkTagResult[] = [];
  for (const entry of preview.filter((entry) => entry.selected)) {
    try {
      const file = app.vault.getMarkdownFiles().find((file) => file.path === entry.path);
      if (!file || pathIsInside(entry.path, settings.dataFolder)) throw new Error("文件已移动、删除或进入数据目录，请重新预览。");
      const cache = app.metadataCache.getFileCache(file);
      if (!cache || !matchesRequest(file.path, getAllTags(cache) ?? [], request)) throw new Error("匹配范围已变化，请重新预览。");
      let changed = false;
      await app.vault.process(file, (current) => {
        if (current !== entry.original) throw new Error("笔记在预览后发生修改，请重新预览。");
        const next = appendTags(current, entry.additions, entry.knownTags);
        changed = next !== current;
        return next;
      });
      results.push({ path: entry.path, status: changed ? "added" : "unchanged", message: changed ? "已添加" : "标签已存在，无需修改" });
    } catch (error) {
      results.push({ path: entry.path, status: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
