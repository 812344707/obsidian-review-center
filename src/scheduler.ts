import {
  Rating,
  State,
  StrategyMode,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type CardInput,
  type Grade,
} from "ts-fsrs";
import type { ReviewItem, ReviewKind, ReviewParameters, SerializedFsrsCard } from "./types";
import { deserializeCard, formatInterval, serializeCard } from "./utils";

export const REVIEW_GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

export const GRADE_LABELS: Record<Grade, string> = {
  [Rating.Again]: "重来",
  [Rating.Hard]: "困难",
  [Rating.Good]: "良好",
  [Rating.Easy]: "简单",
};

export function createSchedule(now = new Date()): SerializedFsrsCard {
  return serializeCard(createEmptyCard(now));
}

export function previewSchedule(
  item: ReviewItem,
  parameters: ReviewParameters,
  now = new Date(),
): Record<Grade, { card: SerializedFsrsCard; interval: string }> {
  const engine = makeScheduler(parameters, item);
  const preview = engine.repeat(schedulingCard(item), schedulingDate(now, item.kind));
  return {
    [Rating.Again]: toPreview(preview[Rating.Again].card, now, parameters.maximumInterval, item.kind),
    [Rating.Hard]: toPreview(preview[Rating.Hard].card, now, parameters.maximumInterval, item.kind),
    [Rating.Good]: toPreview(preview[Rating.Good].card, now, parameters.maximumInterval, item.kind),
    [Rating.Easy]: toPreview(preview[Rating.Easy].card, now, parameters.maximumInterval, item.kind),
  };
}

export function applyRating(
  item: ReviewItem,
  rating: Grade,
  parameters: ReviewParameters,
  now = new Date(),
): ReviewItem {
  const engine = makeScheduler(parameters, item);
  const result = engine.next(schedulingCard(item), schedulingDate(now, item.kind), rating);
  return {
    ...item,
    revision: item.revision + 1,
    schedule: serializeCard(finishSchedule(result.card, now, parameters.maximumInterval, item.kind)),
    lastReviewedAt: now.toISOString(),
  };
}

export function resetSchedule(item: ReviewItem, now = new Date()): ReviewItem {
  return {
    ...item,
    revision: item.revision + 1,
    schedule: createSchedule(now),
    lastReviewedAt: undefined,
    status: "active",
    buriedUntil: undefined, buriedBy: undefined, leech: undefined,
  };
}

export function isNewSchedule(card: SerializedFsrsCard): boolean {
  return card.state === Number(State.New) && card.reps === 0;
}

/** Notes are due on a local calendar day, including schedules from older versions. */
export function reviewDueDate(item: Pick<ReviewItem, "kind" | "schedule">): Date {
  const due = new Date(item.schedule.due);
  if (item.kind !== "note" || !Number.isFinite(due.getTime())) return due;
  due.setHours(0, 0, 0, 0);
  if (item.schedule.reps > 0 && item.schedule.last_review) {
    const earliest = new Date(item.schedule.last_review);
    earliest.setHours(0, 0, 0, 0);
    earliest.setDate(earliest.getDate() + 1);
    // A legacy minute-based learning/relearning step must not bring a note
    // back on the day it was just reviewed. No history rewrite is needed.
    if (due < earliest) return earliest;
  }
  return due;
}

export function isDueSchedule(card: SerializedFsrsCard, now = new Date(), kind: ReviewKind = "qa"): boolean {
  return reviewDueDate({ kind, schedule: card }).getTime() <= now.getTime();
}

// Give FSRS whole calendar-day deltas for notes, independent of clock time or
// daylight saving. Real review timestamps are still retained in saved history.
export function schedulingDate(date: Date, kind: ReviewKind): Date {
  return kind === "note" ? new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) : date;
}

export function schedulingCard(item: Pick<ReviewItem, "kind" | "schedule">): CardInput {
  const card = deserializeCard(item.schedule);
  if (item.kind === "note" && item.schedule.last_review) card.last_review = schedulingDate(new Date(item.schedule.last_review), "note");
  return card;
}

function makeScheduler(parameters: ReviewParameters, item: ReviewItem) {
  return fsrs(
    generatorParameters({
      ...(parameters.weights ? { w: parameters.weights } : {}),
      request_retention: parameters.retention,
      maximum_interval: parameters.maximumInterval,
      enable_short_term: item.kind !== "note",
      learning_steps: parameters.learningSteps as import("ts-fsrs").FSRSParameters["learning_steps"],
      relearning_steps: parameters.relearningSteps as import("ts-fsrs").FSRSParameters["relearning_steps"],
      enable_fuzz: true,
    }),
  ).useStrategy(StrategyMode.SEED, () => `${item.id}:${item.acceptedHash}:${item.schedule.reps}`);
}

// ts-fsrs 5.4.1 can add days after applying its maximum to keep grade
// intervals ordered. Enforce the user's cap for both preview and persistence.
function capInterval(card: Card, now: Date, maximum: number): Card {
  if (card.scheduled_days <= maximum) return card;
  const due = new Date(now);
  due.setDate(due.getDate() + maximum);
  return { ...card, scheduled_days: maximum, due };
}

function finishSchedule(result: Card, now: Date, maximum: number, kind: ReviewKind): Card {
  const card = capInterval(result, now, maximum);
  if (kind !== "note") return card;
  // Convert the computed day count back to the user's local calendar.
  const due = new Date(now);
  due.setDate(due.getDate() + card.scheduled_days);
  due.setHours(0, 0, 0, 0);
  return { ...card, due, last_review: new Date(now) };
}

function toPreview(result: Card, now: Date, maximum: number, kind: ReviewKind): { card: SerializedFsrsCard; interval: string } {
  const card = finishSchedule(result, now, maximum, kind);
  return {
    card: serializeCard(card),
    interval: kind === "note" ? `${card.scheduled_days} 天` : formatInterval(card.due, now),
  };
}
