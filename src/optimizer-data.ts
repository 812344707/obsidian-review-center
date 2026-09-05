import { default_w } from "ts-fsrs";
import { effectiveReviews, eventMode } from "./activity";
import { groupsFor, nodeParameters, parameterPath, resolveGroup, tagsMatch } from "./config";
import type { HistoryEvent, ReviewCenterSettings, ReviewPreset, SourceRecord } from "./types";
import { itemKey, localDayKey } from "./utils";
export interface FilterTerm { field: "preset" | "tag" | "path" | "is"; value: string; exclude: boolean }
export function parseHistoryFilter(input: string): FilterTerm[] {
  const result: FilterTerm[] = [];
  let rest = input.trim();
  while (rest) {
    const match = /^(-?)(preset|tag|path|is):(?:"([^"\n]*)"|([^\s"]+))(?:\s+|$)/.exec(rest);
    if (!match) throw new Error("无法识别历史筛选：" + rest.slice(0, 60));
    const value = match[3] ?? match[4];
    if (!value || (match[2] === "is" && value !== "suspended")) throw new Error("筛选仅支持 preset、tag、path 和 is:suspended。");
    result.push({ field: match[2] as FilterTerm["field"], value, exclude: match[1] === "-" }); rest = rest.slice(match[0].length).trimStart();
  }
  return result;
}
export function learningHistory(history: HistoryEvent[], sourceId: string, id: string): HistoryEvent[] {
  const relevant = history.filter((e) => e.sourceId === sourceId && e.itemId === id);
  const reset = Math.max(0, ...relevant.filter((e) => e.action === "reset" || e.action === "change-reset").map((e) => e.nextRevision));
  return effectiveReviews(relevant).filter((e) => e.baseRevision >= reset);
}
export function buildOptimizerInput(records: SourceRecord[], history: HistoryEvent[], settings: ReviewCenterSettings, preset: ReviewPreset, action: "optimize" | "retention", now = new Date()) {
  const filter = parseHistoryFilter(preset.parameters.historyFilter ?? "-is:suspended");
  const samples: Array<{ reviews: Array<{ rating: number; delta_t: number }>; cid: number; lastAt: string }> = [];
  const logs: Array<{ id: number; cid: number; rating: number; interval: number; last_interval: number; duration: number; kind: number }> = [];
  let deckSize = 0, cid = 0;
  const byItem = new Map<string, HistoryEvent[]>();
  for (const event of history) { const key = itemKey(event.sourceId, event.itemId); const list = byItem.get(key) ?? []; list.push(event); byItem.set(key, list); }
  for (const record of records) {
    if (["deleted", "out-of-scope"].includes(record.sourceStatus)) continue;
    const group = resolveGroup(record.tags, groupsFor(settings, preset.mode), record.sourcePath); if (!group) continue;
    const owner = nodeParameters(settings, preset.mode, group, parameterPath(record.tags, group)); if (owner.presetId !== preset.id) continue;
    for (const item of preset.mode === "note" ? [record.note] : Object.values(record.cards)) {
      if (["removed", "pending-change"].includes(item.status)) continue;
      if (!filter.every((term) => {
        const match = term.field === "preset" ? [preset.id, preset.name].includes(term.value) : term.field === "tag" ? tagsMatch(record.tags, term.value.replace(/^#/, "").toLowerCase()) : term.field === "path" ? record.sourcePath.toLowerCase().includes(term.value.toLowerCase()) : item.status === "suspended";
        return term.exclude ? !match : match;
      })) continue;
      deckSize++; cid++;
      const events = learningHistory(byItem.get(itemKey(record.reviewId, item.id)) ?? [], record.reviewId, item.id).filter((e) => eventMode(e) === preset.mode);
      // A sequence without its first learning review cannot reconstruct an initial memory state.
      if (!events.length || !(events[0].wasNew ?? events[0].after?.schedule.reps === 1)) continue;
      const sequence: Array<{ rating: number; delta_t: number }> = [];
      let previousDay = 0, previousInterval = 0, previousState = 0;
      for (const [index, event] of events.entries()) {
        const date = new Date(event.occurredAt), day = Date.parse(localDayKey(date) + "T00:00:00Z") / 86400000;
        sequence.push({ rating: event.rating!, delta_t: index ? Math.max(0, Math.round(day - previousDay)) : 0 }); previousDay = day;
        samples.push({ cid, reviews: sequence.map((r) => ({ ...r })), lastAt: event.occurredAt });
        const card = event.after!.schedule, interval = card.scheduled_days > 0 ? card.scheduled_days : -Math.max(1, Math.round((new Date(card.due).getTime() - date.getTime()) / 1000));
        logs.push({ id: date.getTime(), cid, rating: event.rating!, interval, last_interval: previousInterval, duration: Math.min(300000, Math.max(0, event.durationMs ?? 0)), kind: previousState === 2 ? 1 : previousState === 3 ? 2 : 0 });
        previousInterval = interval; previousState = card.state;
      }
    }
  }
  const p = preset.parameters;
  return { action, samples: samples.sort((a, b) => a.lastAt.localeCompare(b.lastAt)), logs: logs.sort((a, b) => a.id - b.id),
    weights: p.weights ?? [...default_w], health: p.healthCheck !== false, learning_steps: p.learningSteps.length, relearning_steps: p.relearningSteps.length,
    new_limit: p.newLimit, review_limit: p.reviewLimit, maximum_interval: p.maximumInterval, new_ignore_review: p.newIgnoreReviewLimit !== false,
    deck_size: deckSize, cutoff: Math.round(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000) };
}
