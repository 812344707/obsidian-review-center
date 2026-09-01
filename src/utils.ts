import type { Card, CardInput } from "ts-fsrs";
import type { SerializedFsrsCard } from "./types";

export function createId(prefix: string): string {
  const uuid = crypto.randomUUID?.() ?? randomFallback();
  return `${prefix}-${uuid.toLowerCase()}`;
}

function randomFallback(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const result = character === "x" ? value : (value & 0x3) | 0x8;
    return result.toString(16);
  });
}

export function hashText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function serializeCard(card: Card): SerializedFsrsCard {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    ...(card.last_review ? { last_review: card.last_review.toISOString() } : {}),
  };
}

export function deserializeCard(card: SerializedFsrsCard): CardInput {
  return {
    ...card,
    due: card.due,
    last_review: card.last_review ?? null,
  };
}

export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatInterval(due: Date, now: Date): string {
  const milliseconds = Math.max(0, due.getTime() - now.getTime());
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月`;
  const years = Math.round((days / 365) * 10) / 10;
  return `${years} 年`;
}

export function pathIsInside(path: string, folder: string): boolean {
  const normalizedFolder = folder.replace(/^\/+|\/+$/g, "");
  if (normalizedFolder === "") return true;
  return path === normalizedFolder || path.startsWith(`${normalizedFolder}/`);
}

export function isWatchedPath(
  path: string,
  watchedFolders: string[],
  excludedFolders: string[],
  dataFolder: string,
): boolean {
  if (pathIsInside(path, dataFolder)) return false;
  if (watchedFolders.length === 0) return false;
  const included = watchedFolders.some((folder) => pathIsInside(path, folder));
  const excluded = excludedFolders.some((folder) => pathIsInside(path, folder));
  return included && !excluded;
}

export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function itemKey(sourceId: string, itemId: string): string {
  return `${sourceId}::${itemId}`;
}
