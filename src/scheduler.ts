import {
  Rating,
  State,
  StrategyMode,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type Grade,
} from "ts-fsrs";
import type { ReviewItem, ReviewParameters, SerializedFsrsCard } from "./types";
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
  const preview = engine.repeat(deserializeCard(item.schedule), now);
  return {
    [Rating.Again]: toPreview(preview[Rating.Again].card, now, parameters.maximumInterval),
    [Rating.Hard]: toPreview(preview[Rating.Hard].card, now, parameters.maximumInterval),
    [Rating.Good]: toPreview(preview[Rating.Good].card, now, parameters.maximumInterval),
    [Rating.Easy]: toPreview(preview[Rating.Easy].card, now, parameters.maximumInterval),
  };
}

export function applyRating(
  item: ReviewItem,
  rating: Grade,
  parameters: ReviewParameters,
  now = new Date(),
): ReviewItem {
  const engine = makeScheduler(parameters, item);
  const result = engine.next(deserializeCard(item.schedule), now, rating);
  return {
    ...item,
    revision: item.revision + 1,
    schedule: serializeCard(capInterval(result.card, now, parameters.maximumInterval)),
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
  };
}

export function isNewSchedule(card: SerializedFsrsCard): boolean {
  return card.state === Number(State.New) && card.reps === 0;
}

export function isDueSchedule(card: SerializedFsrsCard, now = new Date()): boolean {
  return new Date(card.due).getTime() <= now.getTime();
}

function makeScheduler(parameters: ReviewParameters, item: ReviewItem) {
  return fsrs(
    generatorParameters({
      request_retention: parameters.retention,
      maximum_interval: parameters.maximumInterval,
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

function toPreview(result: Card, now: Date, maximum: number): { card: SerializedFsrsCard; interval: string } {
  const card = capInterval(result, now, maximum);
  return {
    card: serializeCard(card),
    interval: formatInterval(card.due, now),
  };
}
