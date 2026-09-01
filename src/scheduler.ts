import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type Grade,
} from "ts-fsrs";
import type { ReviewItem, SerializedFsrsCard } from "./types";
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
  retention: number,
  now = new Date(),
): Record<Grade, { card: SerializedFsrsCard; interval: string }> {
  const engine = makeScheduler(retention);
  const preview = engine.repeat(deserializeCard(item.schedule), now);
  return {
    [Rating.Again]: toPreview(preview[Rating.Again].card, now),
    [Rating.Hard]: toPreview(preview[Rating.Hard].card, now),
    [Rating.Good]: toPreview(preview[Rating.Good].card, now),
    [Rating.Easy]: toPreview(preview[Rating.Easy].card, now),
  };
}

export function applyRating(
  item: ReviewItem,
  rating: Grade,
  retention: number,
  now = new Date(),
): ReviewItem {
  const engine = makeScheduler(retention);
  const result = engine.next(deserializeCard(item.schedule), now, rating);
  return {
    ...item,
    revision: item.revision + 1,
    schedule: serializeCard(result.card),
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

function makeScheduler(retention: number) {
  return fsrs(
    generatorParameters({
      request_retention: Math.max(0.7, Math.min(0.99, retention)),
      enable_fuzz: true,
    }),
  );
}

function toPreview(card: Card, now: Date): { card: SerializedFsrsCard; interval: string } {
  return {
    card: serializeCard(card),
    interval: formatInterval(card.due, now),
  };
}
