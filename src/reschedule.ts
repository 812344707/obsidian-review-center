import { fsrs, generatorParameters, type Grade } from "ts-fsrs";
import { collectEntries } from "./queue";
import { learningHistory } from "./optimizer-data";
import { cloneValue, createId, deserializeCard, serializeCard } from "./utils";
import { createHistoryEvent } from "./history";
import type ReviewCenterPlugin from "./main";
import type { HistoryEvent, ReviewCenterSettings, ReviewItem, SourceRecord } from "./types";
export interface ScheduledChange { sourceId: string; path: string; before: ReviewItem; after: ReviewItem; event?: HistoryEvent; done?: boolean; error?: string }
export interface RescheduleJob { kind: "reschedule"; state: "pending" | "done"; createdAt: string; settings: ReviewCenterSettings; baseline: string; entries: ScheduledChange[]; backup?: string }
export function schedulingSignature(settings: ReviewCenterSettings): string { return JSON.stringify([settings.noteGroups, settings.cardGroups, settings.presets]); }
function parametersKey(p: import("./types").ReviewParameters): string { return JSON.stringify([p.weights, p.retention, p.maximumInterval, p.learningSteps, p.relearningSteps]); }
export function planReschedule(records: SourceRecord[], history: HistoryEvent[], previous: ReviewCenterSettings, next: ReviewCenterSettings): { entries: ScheduledChange[]; skipped: string[] } {
  const entries: ScheduledChange[] = [], skipped: string[] = [];
  // Suspended items retain their status, but their dates can also be rescheduled.
  const all = records.map((r) => ({ ...r, note: { ...r.note, status: r.note.status === "suspended" ? "active" as const : r.note.status }, cards: Object.fromEntries(Object.entries(r.cards).map(([id, i]) => [id, { ...i, status: i.status === "suspended" ? "active" : i.status }])) }));
  for (const mode of ["note", "card"] as const) {
    const before = new Map(collectEntries(all, mode, previous).map((e) => [e.sourceId + "::" + e.item.id, e]));
    for (const entry of collectEntries(all, mode, next)) {
      const old = before.get(entry.sourceId + "::" + entry.item.id), p = entry.group.parameters;
      if (!old || !p.rescheduleOnChange || parametersKey(old.group.parameters) === parametersKey(p) || entry.item.schedule.state !== 2) continue;
      const original = records.find((r) => r.reviewId === entry.sourceId)!;
      const item = entry.item.id === "note" ? original.note : original.cards[entry.item.id];
      const reviews = learningHistory(history, entry.sourceId, entry.item.id);
      if (!reviews.length || !(reviews[0].wasNew ?? reviews[0].after?.schedule.reps === 1)) { skipped.push(entry.sourcePath + " · 缺少完整学习历史"); continue; }
      const engine = fsrs(generatorParameters({ w: p.weights, request_retention: p.retention, maximum_interval: p.maximumInterval, enable_fuzz: false,
        learning_steps: p.learningSteps as import("ts-fsrs").FSRSParameters["learning_steps"], relearning_steps: p.relearningSteps as import("ts-fsrs").FSRSParameters["relearning_steps"] }));
      const replay = engine.reschedule(deserializeCard(item.schedule), reviews.map((e) => ({ rating: e.rating as Grade, review: e.occurredAt })), { update_memory_state: true });
      const final = replay.collections.at(-1)?.card; if (!final) continue;
      const interval = Math.min(p.maximumInterval, engine.next_interval(final.stability, 0));
      const due = new Date(item.schedule.last_review ?? reviews.at(-1)!.occurredAt); due.setDate(due.getDate() + interval);
      const computed = serializeCard(final);
      const after: ReviewItem = { ...cloneValue(item), revision: item.revision + 1, schedule: { ...item.schedule, stability: computed.stability, difficulty: computed.difficulty, due: due.toISOString(), scheduled_days: interval } };
      entries.push({ sourceId: entry.sourceId, path: entry.sourcePath, before: cloneValue(item), after });
    }
  }
  return { entries, skipped };
}
export async function runRescheduleJob(host: ReviewCenterPlugin, id: string, job: RescheduleJob): Promise<void> {
  await host.service.runMaintenance(async () => {
    const current = schedulingSignature(host.settings);
    if (current !== job.baseline && current !== schedulingSignature(job.settings)) throw new Error("设置在操作后发生变化，请先查看备份和未完成操作，避免覆盖新设置。");
    if (!job.backup) {
      job.backup = await host.store.writeBackup({ schemaVersion: 4, kind: "full", exportedAt: new Date().toISOString(), pluginVersion: host.manifest.version,
        settings: cloneValue(host.settings), records: cloneValue(host.service.records), history: cloneValue(host.service.history) }, "pre-reschedule");
      for (const entry of job.entries) entry.event = createHistoryEvent({ sessionId: host.store.sessionId, deviceId: host.store.deviceId, sourceId: entry.sourceId, itemId: entry.before.id, action: "reschedule", baseRevision: entry.before.revision, after: entry.after });
      await host.store.saveJob(id, job);
    }
    for (const entry of job.entries) {
      if (entry.done) continue;
      const record = host.service.records.find((r) => r.reviewId === entry.sourceId), current = entry.before.id === "note" ? record?.note : record?.cards[entry.before.id];
      if (!record || !current) { entry.error = "内容已移除，保留当前状态"; entry.done = true; }
      else if (host.service.history.some((e) => e.eventId === entry.event!.eventId)) {
        if (current.revision <= entry.after.revision) { if (entry.after.id === "note") record.note = cloneValue(entry.after); else record.cards[entry.after.id] = cloneValue(entry.after); await host.store.saveRecord(record); }
        entry.done = true;
      } else if (JSON.stringify(current) !== JSON.stringify(entry.before)) { entry.error = "内容或进度已变化，未覆盖"; entry.done = true; }
      else {
        await host.store.appendHistory([entry.event!]); host.service.history.push(entry.event!);
        if (entry.after.id === "note") record.note = cloneValue(entry.after); else record.cards[entry.after.id] = cloneValue(entry.after);
        await host.store.saveRecord(record); entry.done = true;
      }
      await host.store.saveJob(id, job);
    }
    await host.persistSettingsInMaintenance({ ...host.settings, noteGroups: job.settings.noteGroups, cardGroups: job.settings.cardGroups, presets: job.settings.presets });
    job.state = "done"; await host.store.saveJob(id, job);
  });
  await host.refreshData();
}
export function createRescheduleJob(host: ReviewCenterPlugin, next: ReviewCenterSettings, entries: ScheduledChange[]): { id: string; job: RescheduleJob } {
  return { id: createId("reschedule"), job: { kind: "reschedule", state: "pending", createdAt: new Date().toISOString(), baseline: schedulingSignature(host.settings), settings: cloneValue(next), entries } };
}
