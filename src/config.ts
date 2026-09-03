import type { ReviewCenterSettings, ReviewGroup, ReviewMode, ReviewParameters, ReviewPreset, NodeOptions } from "./types";
import { createId, localDayKey } from "./utils";

export function defaultParameters(mode: ReviewMode): ReviewParameters {
  return {
    newLimit: mode === "note" ? 1 : 10,
    reviewLimit: mode === "note" ? 10 : 100,
    retention: mode === "note" ? 0.85 : 0.9,
    learningSteps: ["1m", "10m"],
    relearningSteps: ["10m"],
    maximumInterval: 36500,
    newIgnoreReviewLimit: true, limitsFromTop: false, insertion: "sequential",
    newGather: "created", newSort: "gather", newOrder: "after", interdayOrder: "before", reviewSort: "due",
    leechThreshold: 8, leechAction: "tag", buryNew: false, buryReview: false, buryInterday: false,
    historyFilter: "-is:suspended", healthCheck: true, rescheduleOnChange: false,
  };
}

export function createGroup(mode: ReviewMode): ReviewGroup {
  return { id: createId("group"), name: mode === "note" ? "笔记复习" : "卡片复习", tags: [], nodes: {}, parameters: defaultParameters(mode) };
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
    ...advancedParameters(p),
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
      if (value == null) group.tags = ["review"];
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
        presetId: typeof entry.presetId === "string" ? entry.presetId : undefined,
        nodes: normalizeNodes(entry.nodes),
      };
    });
  };
  const noteGroups = groups("note"), cardGroups = groups("card");
  const presets: ReviewPreset[] = [];
  for (const raw of Array.isArray(data.presets) ? data.presets : []) {
    const p = object(raw);
    if (typeof p.id !== "string" || !p.id || !["note", "card"].includes(String(p.mode)) || presets.some((x) => x.id === p.id)) continue;
    const mode = p.mode as ReviewMode;
    presets.push({ id: p.id, mode, name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "默认预设", parameters: normalizeParameters(p.parameters, mode) });
  }
  for (const mode of ["note", "card"] as const) for (const group of mode === "note" ? noteGroups : cardGroups) {
    let preset = presets.find((p) => p.id === group.presetId && p.mode === mode);
    if (!preset) {
      let id = `preset-${mode}-${group.id}`;
      if (presets.some((p) => p.id === id)) id = createId("preset");
      preset = { id, mode, name: group.name, parameters: group.parameters };
      presets.push(preset);
    }
    group.presetId = preset.id; group.parameters = preset.parameters;
  }
  return {
    noteGroups, cardGroups, presets,
    showNoteHeatmap: data.showNoteHeatmap !== false, showCardHeatmap: data.showCardHeatmap !== false,
    reviewHeading: typeof data.reviewHeading === "string" && data.reviewHeading.trim() ? data.reviewHeading.trim() : "复习",
    reviewHeadingLevel: number(data.reviewHeadingLevel, 2, 1, 6),
    // Keep the persisted field for backup compatibility, while recognition is
    // deliberately fixed to the single documented [!review] callout type.
    reviewCalloutTypes: ["review"],
    dataFolder: typeof data.dataFolder === "string" && data.dataFolder.replace(/^\/+|\/+$/g, "").trim() ? data.dataFolder.replace(/^\/+|\/+$/g, "").trim() : "复习中心数据",
    autoOpenDashboard: data.autoOpenDashboard === true,
  };
}

export const DEFAULT_SETTINGS = normalizeSettings(null);

function advancedParameters(p: Record<string, unknown>): Partial<ReviewParameters> {
  const choice = <const T extends string>(key: string, choices: T[], fallback: T): T => choices.includes(p[key] as T) ? p[key] as T : fallback;
  return {
    newIgnoreReviewLimit: p.newIgnoreReviewLimit !== false, limitsFromTop: p.limitsFromTop === true,
    insertion: choice("insertion", ["sequential", "random"], "sequential"),
    newGather: choice("newGather", ["created", "created-desc", "group", "random-note", "random-card"], "created"),
    newSort: choice("newSort", ["gather", "type", "random-note", "random"], "gather"),
    newOrder: choice("newOrder", ["before", "mixed", "after"], "after"),
    interdayOrder: choice("interdayOrder", ["before", "mixed", "after"], "before"),
    reviewSort: choice("reviewSort", ["due", "due-random", "group", "interval", "interval-desc", "difficulty", "difficulty-desc", "retention", "retention-desc", "random"], "due"),
    leechThreshold: number(p.leechThreshold, 8, 1, 999), leechAction: choice("leechAction", ["tag", "suspend"], "tag"),
    buryNew: p.buryNew === true, buryReview: p.buryReview === true, buryInterday: p.buryInterday === true,
    weights: Array.isArray(p.weights) && p.weights.length === 21 && p.weights.every((v) => typeof v === "number" && Number.isFinite(v)) ? [...p.weights] as number[] : undefined,
    historyFilter: typeof p.historyFilter === "string" ? p.historyFilter : "-is:suspended",
    healthCheck: p.healthCheck !== false, rescheduleOnChange: p.rescheduleOnChange === true,
  };
}
function normalizeNodes(value: unknown): Record<string, NodeOptions> {
  const result: Record<string, NodeOptions> = Object.create(null);
  for (const [path, raw] of Object.entries(object(value))) {
    if (["__proto__", "constructor", "prototype"].includes(path) || (path && normalizeTags([path])[0] !== path)) continue;
    const node = object(raw), limits = object(node.limits), today = object(node.today);
    const validLimit = (n: unknown): number | undefined => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 99999 ? n : undefined;
    result[path] = {
      presetId: typeof node.presetId === "string" ? node.presetId : undefined,
      retention: typeof node.retention === "number" ? number(node.retention, 0.9, 0.7, 0.99, false) : undefined,
      limits: { newLimit: validLimit(limits.newLimit), reviewLimit: validLimit(limits.reviewLimit) },
      today: typeof today.date === "string" ? { date: today.date, newLimit: validLimit(today.newLimit), reviewLimit: validLimit(today.reviewLimit) } : undefined,
    };
  }
  return result;
}
export function tagMatches(actual: string, prefix: string): boolean { return actual === prefix || actual.startsWith(prefix + "/"); }
export function tagsMatch(tags: string[], prefix?: string): boolean { return !prefix || normalizeTags(tags).some((tag) => tagMatches(tag, prefix)); }
export function naturalCompare(a: string, b: string): number {
  const ordinal = (text: string) => text.replace(/第([零〇一二两三四五六七八九十百千]+)/g, (_, digits: string) => {
    const values: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }; let total = 0, current = 0;
    for (const char of digits) { if (units[char]) { total += (current || 1) * units[char]; current = 0; } else current = values[char]; }
    return "第" + (total + current);
  });
  return ordinal(a).localeCompare(ordinal(b), "zh-CN", { numeric: true }) || a.localeCompare(b, "zh-CN");
}
export function parameterPath(tags: string[], group: ReviewGroup): string {
  return normalizeTags(tags).filter((tag) => group.tags.some((root) => tagMatches(tag, root)))
    .sort((a, b) => b.split("/").length - a.split("/").length || naturalCompare(a, b))[0] ?? "";
}
export function nodeParameters(settings: ReviewCenterSettings, mode: ReviewMode, group: ReviewGroup, path = "", now = new Date()): { parameters: ReviewParameters; presetId?: string } {
  const lineage = Object.keys(group.nodes ?? {}).filter((p) => p === "" || tagMatches(path, p)).sort((a, b) => a.length - b.length);
  let presetId = group.presetId;
  for (const p of lineage) if (group.nodes?.[p].presetId && settings.presets?.some((x) => x.id === group.nodes![p].presetId && x.mode === mode)) presetId = group.nodes[p].presetId;
  let parameters = { ...(settings.presets?.find((p) => p.id === presetId && p.mode === mode)?.parameters ?? group.parameters) };
  // Numeric overrides belong to a node, whereas the parameter preset is inherited.
  const node = group.nodes?.[path];
  for (const path of lineage) if (group.nodes?.[path].retention !== undefined) parameters.retention = group.nodes[path].retention!;
  for (const key of ["newLimit", "reviewLimit"] as const) {
    if (node?.limits?.[key] !== undefined) parameters[key] = node.limits[key]!;
    if (node?.today?.date === localDayKey(now) && node.today[key] !== undefined) parameters[key] = node.today[key]!;
  }
  return { parameters, presetId };
}
