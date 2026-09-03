import type { ReviewCenterSettings, ReviewGroup, ReviewMode, ReviewParameters } from "./types";
import { createId } from "./utils";

export function defaultParameters(mode: ReviewMode): ReviewParameters {
  return {
    newLimit: mode === "note" ? 1 : 10,
    reviewLimit: mode === "note" ? 10 : 100,
    retention: mode === "note" ? 0.85 : 0.9,
    learningSteps: ["1m", "10m"],
    relearningSteps: ["10m"],
    maximumInterval: 36500,
  };
}

export function createGroup(mode: ReviewMode): ReviewGroup {
  return { id: createId("group"), name: mode === "note" ? "笔记复习" : "卡片复习", tags: [], parameters: defaultParameters(mode) };
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().replace(/^#+/, "").toLowerCase()).filter(Boolean))];
}

export function parseTags(text: string): string[] {
  const tags = normalizeTags(text.split(/[\s,，]+/));
  if (tags.some((tag) => !/^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag) || tag.split("/").some((part) => !part) || /^\d+$/.test(tag))) {
    throw new Error("标签可含文字、数字、下划线、连字符和 /，不能是纯数字或包含空层级。");
  }
  return tags;
}

export function parseCalloutTypes(text: string): string[] {
  const types = [...new Set(["review", ...text.toLowerCase().split(/[\s,，]+/).filter(Boolean)])];
  if (types.some((type) => !/^[a-z][a-z0-9_-]*$/.test(type))) {
    throw new Error("类型用英文字母开头，可含数字、下划线和连字符，例如 review 或 study-card。");
  }
  return types;
}

export function validateDataFolder(value: string): string {
  const path = value.trim().replace(/\/$/, "");
  if (!path || /^[\\/]|^[a-z]:/i.test(path) || /[\\\u0000-\u001f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("请输入知识库内的子目录，例如 学习数据/复习中心；不能使用绝对路径或 ../。");
  }
  return path;
}

export function parseSteps(text: string): string[] {
  const steps = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const step of steps) {
    const match = /^(\d+(?:\.\d+)?)(m|h)$/.exec(step);
    const minutes = match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : NaN;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes >= 1440) {
      throw new Error("用空格分隔步长，例如 1m 10m；每步至少 1 分钟、小于 24 小时。留空由 FSRS 安排。");
    }
  }
  return steps;
}

export function groupsFor(settings: ReviewCenterSettings, mode: ReviewMode): ReviewGroup[] {
  return mode === "note" ? settings.noteGroups : settings.cardGroups;
}

export function resolveGroup(tags: string[], groups: ReviewGroup[]): ReviewGroup | undefined {
  const normalized = normalizeTags(tags);
  let winner: ReviewGroup | undefined;
  let bestDepth = 0;
  for (const group of groups) {
    for (const tag of normalizeTags(group.tags)) {
      if (normalized.some((actual) => actual === tag || actual.startsWith(`${tag}/`))) {
        const depth = tag.split("/").length;
        if (depth > bestDepth) { bestDepth = depth; winner = group; }
      }
    }
  }
  return winner;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback: number, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const bounded = Math.max(min, Math.min(max, value));
  return integer ? Math.round(bounded) : bounded;
}

export function normalizeParameters(value: unknown, mode: ReviewMode): ReviewParameters {
  const p = object(value);
  const defaults = defaultParameters(mode);
  const steps = (key: "learningSteps" | "relearningSteps") => {
    try {
      if (!Array.isArray(p[key]) || !(p[key] as unknown[]).every((s) => typeof s === "string")) return defaults[key];
      return parseSteps((p[key] as string[]).join(" "));
    } catch { return defaults[key]; }
  };
  return {
    newLimit: number(p.newLimit, defaults.newLimit, 0, mode === "note" ? 999 : 9999),
    reviewLimit: number(p.reviewLimit, defaults.reviewLimit, 0, mode === "note" ? 9999 : 99999),
    retention: number(p.retention, defaults.retention, 0.7, 0.99, false),
    maximumInterval: number(p.maximumInterval, defaults.maximumInterval, 1, 36500),
    learningSteps: steps("learningSteps"), relearningSteps: steps("relearningSteps"),
  };
}

/** v1 folder settings become empty tag groups, without changing any source notes. */
export function normalizeSettings(value: unknown): ReviewCenterSettings {
  const data = object(value);
  const groups = (mode: ReviewMode): ReviewGroup[] => {
    const stored = data[`${mode}Groups`];
    if (!Array.isArray(stored)) {
      const group = createGroup(mode);
      group.id = `default-${mode}`;
      group.parameters = normalizeParameters({
        newLimit: data[`${mode}NewLimit`], reviewLimit: data[`${mode}ReviewLimit`], retention: data[`${mode}Retention`],
      }, mode);
      return [group];
    }
    const seen = new Set<string>();
    return stored.map((value) => {
      const entry = object(value);
      let id = typeof entry.id === "string" && entry.id ? entry.id : createId("group");
      if (seen.has(id)) id = createId("group");
      seen.add(id);
      let tags: string[] = [];
      try { tags = parseTags(Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === "string").join("\n") : ""); } catch { /* Invalid scope stays empty. */ }
      return {
        id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : mode === "note" ? "笔记复习" : "卡片复习",
        tags, parameters: normalizeParameters(entry.parameters, mode),
      };
    });
  };
  return {
    noteGroups: groups("note"), cardGroups: groups("card"),
    showNoteHeatmap: data.showNoteHeatmap !== false, showCardHeatmap: data.showCardHeatmap !== false,
    reviewHeading: typeof data.reviewHeading === "string" && data.reviewHeading.trim() ? data.reviewHeading.trim() : "复习",
    reviewHeadingLevel: number(data.reviewHeadingLevel, 2, 1, 6),
    reviewCalloutTypes: (() => {
      try { return parseCalloutTypes(Array.isArray(data.reviewCalloutTypes) ? data.reviewCalloutTypes.filter((t) => typeof t === "string").join(" ") : ""); }
      catch { return ["review"]; }
    })(),
    dataFolder: typeof data.dataFolder === "string" && data.dataFolder.replace(/^\/+|\/+$/g, "").trim() ? data.dataFolder.replace(/^\/+|\/+$/g, "").trim() : "复习中心数据",
    autoOpenDashboard: data.autoOpenDashboard === true,
  };
}

export const DEFAULT_SETTINGS = normalizeSettings(null);
