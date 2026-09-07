import { createGroup, groupsFor, parseTags } from "./config";
import { groupFilter } from "./recognition";
import type { ReviewCenterSettings, ReviewGroup, ReviewMode } from "./types";
import { cloneValue, createId } from "./utils";

/** Only treat an existing scope as a tag when the behavior is identical. */
export function groupTag(group: ReviewGroup): string | undefined {
  const rules = groupFilter(group).rules;
  if (rules.length !== 1 || rules[0].field !== "tag" || rules[0].operator !== "contains") return undefined;
  try { const tags = parseTags(rules[0].value); return tags.length === 1 ? tags[0] : undefined; }
  catch { return undefined; }
}

export function groupLabel(group: ReviewGroup): string { const tag = groupTag(group); return tag ? "#" + tag : group.name; }

export function tagGroups(groups: ReviewGroup[]): ReviewGroup[] {
  const seen = new Set<string>();
  return groups.filter((group) => {
    const tag = groupTag(group);
    if (!tag || seen.has(tag)) return false;
    seen.add(tag); return true;
  });
}

/** Keep IDs, options and order for retained tags; never reinterpret old rules. */
export function setReviewTags(settings: ReviewCenterSettings, mode: ReviewMode, values: string[]): void {
  const tags = parseTags(values.join("\n")), groups = groupsFor(settings, mode), editable = new Set(tagGroups(groups));
  const retained = groups.filter((group) => !editable.has(group) || tags.includes(groupTag(group)!));
  const existing = new Set(retained.map(groupTag).filter(Boolean));
  for (const tag of tags) {
    if (existing.has(tag)) continue;
    const group = createGroup(mode);
    group.name = "#" + tag; group.tags = [tag]; group.presetId = createId("preset");
    (settings.presets ??= []).push({ id: group.presetId, name: group.name, mode, parameters: cloneValue(group.parameters) });
    retained.push(group); existing.add(tag);
  }
  if (mode === "note") settings.noteGroups = retained; else settings.cardGroups = retained;
}

export function replaceGroupTag(settings: ReviewCenterSettings, mode: ReviewMode, groupId: string, value: string): void {
  const tags = parseTags(value), groups = groupsFor(settings, mode), group = groups.find((g) => g.id === groupId);
  if (tags.length !== 1) throw new Error("请选择或输入一个标签。");
  if (!group) throw new Error("原有分组已不存在，请重新打开设置。");
  if (groups.some((g) => g.id !== groupId && groupTag(g) === tags[0])) throw new Error("这个标签已用于本类复习，请选择其他标签。");
  group.tags = tags; group.name = "#" + tags[0]; delete group.recognition;
}
