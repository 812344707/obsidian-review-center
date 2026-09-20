import type { DataAdapter } from "obsidian";
import type { ReviewCenterSettings, StoredPluginData } from "./types";
import { createId } from "./utils";

export const SETTINGS_MIRROR_FOLDER = ".review-center";
export const SETTINGS_MIRROR_PATH = `${SETTINGS_MIRROR_FOLDER}/settings.json`;

export interface SettingsSnapshot extends StoredPluginData {
  settingsRevision: string;
  settingsUpdatedAt: string;
}

interface StoredSettingsCandidate {
  schemaVersion?: number;
  settings: ReviewCenterSettings;
  settingsRevision?: string;
  settingsUpdatedAt?: string;
}

export interface SettingsChoice {
  data: StoredSettingsCandidate | null;
  source: "primary" | "mirror" | "none";
  invalidPrimary: boolean;
  synchronize: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function candidate(value: unknown): StoredSettingsCandidate | null {
  const data = object(value), settings = object(data?.settings);
  if (!data || !settings) return null;
  return {
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : undefined,
    settings: settings as unknown as ReviewCenterSettings,
    settingsRevision: typeof data.settingsRevision === "string" && data.settingsRevision ? data.settingsRevision : undefined,
    settingsUpdatedAt: typeof data.settingsUpdatedAt === "string" && data.settingsUpdatedAt ? data.settingsUpdatedAt : undefined,
  };
}

function validTime(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function snapshot(value: unknown): SettingsSnapshot | null {
  const data = candidate(value);
  if (data?.schemaVersion !== 4 || !data.settingsRevision || validTime(data.settingsUpdatedAt) === null) return null;
  return data as SettingsSnapshot;
}

function sameRevision(primary: StoredSettingsCandidate, mirror: SettingsSnapshot): boolean {
  return Boolean(primary.settingsRevision && primary.settingsRevision === mirror.settingsRevision
    && JSON.stringify(primary.settings) === JSON.stringify(mirror.settings));
}

/**
 * Prefer the vault mirror when plugin data was recreated, rolled back or lost.
 * Legacy plugin data remains authoritative only until its one-time migration.
 */
export function chooseStoredSettings(primaryValue: unknown, mirror: SettingsSnapshot | null): SettingsChoice {
  const primary = candidate(primaryValue);
  const invalidPrimary = primaryValue !== null && primaryValue !== undefined && !primary;
  if (!primary) {
    return mirror
      ? { data: mirror, source: "mirror", invalidPrimary, synchronize: true }
      : { data: null, source: "none", invalidPrimary, synchronize: false };
  }
  if (!mirror) {
    return {
      data: primary,
      source: "primary",
      invalidPrimary,
      synchronize: primary.schemaVersion === 4,
    };
  }
  if (primary.schemaVersion !== 4 || !primary.settingsRevision) {
    return { data: mirror, source: "mirror", invalidPrimary, synchronize: true };
  }
  if (sameRevision(primary, mirror)) {
    return { data: primary, source: "primary", invalidPrimary, synchronize: false };
  }
  const primaryTime = validTime(primary.settingsUpdatedAt);
  const mirrorTime = validTime(mirror.settingsUpdatedAt)!;
  if (primaryTime !== null && primaryTime >= mirrorTime) {
    return { data: primary, source: "primary", invalidPrimary, synchronize: true };
  }
  return { data: mirror, source: "mirror", invalidPrimary, synchronize: true };
}

export function createSettingsSnapshot(settings: ReviewCenterSettings, now = new Date()): SettingsSnapshot {
  return {
    schemaVersion: 4,
    settings,
    settingsRevision: createId("settings"),
    settingsUpdatedAt: now.toISOString(),
  };
}

export async function readSettingsMirror(adapter: DataAdapter): Promise<SettingsSnapshot | null> {
  if (!(await adapter.exists(SETTINGS_MIRROR_PATH))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(await adapter.read(SETTINGS_MIRROR_PATH)); }
  catch (error) { throw new Error(`设置镜像无法读取：${error instanceof Error ? error.message : String(error)}`); }
  const stored = snapshot(parsed);
  if (!stored) throw new Error("设置镜像格式无效");
  return stored;
}

export async function writeSettingsMirror(adapter: DataAdapter, data: SettingsSnapshot): Promise<void> {
  if (!(await adapter.exists(SETTINGS_MIRROR_FOLDER))) await adapter.mkdir(SETTINGS_MIRROR_FOLDER);
  else if ((await adapter.stat(SETTINGS_MIRROR_FOLDER))?.type !== "folder") throw new Error("设置镜像目录被同名文件占用");
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await adapter.write(SETTINGS_MIRROR_PATH, serialized);
  if (await adapter.read(SETTINGS_MIRROR_PATH) !== serialized) throw new Error("设置镜像写入后核对失败");
}
