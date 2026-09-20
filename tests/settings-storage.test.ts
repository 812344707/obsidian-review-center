import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DataAdapter } from "obsidian";
import { normalizeSettings } from "../src/config";
import {
  SETTINGS_MIRROR_PATH,
  chooseStoredSettings,
  createSettingsSnapshot,
  readSettingsMirror,
  writeSettingsMirror,
} from "../src/settings-storage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; adapter: DataAdapter }> {
  const root = await mkdtemp(join(tmpdir(), "review-settings-test-"));
  roots.push(root);
  const adapter = {
    exists: async (path: string) => { try { await stat(join(root, path)); return true; } catch { return false; } },
    stat: async (path: string) => { const value = await stat(join(root, path)); return { type: value.isDirectory() ? "folder" : "file" }; },
    mkdir: async (path: string) => { await mkdir(join(root, path), { recursive: true }); },
    read: async (path: string) => readFile(join(root, path), "utf8"),
    write: async (path: string, data: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), data); },
  } as unknown as DataAdapter;
  return { root, adapter };
}

describe("settings persistence across plugin updates", () => {
  it("writes and reads a verified vault mirror without storing a secret value", async () => {
    const h = await fixture(), settings = normalizeSettings(null);
    settings.dataFolder = "99-附件/复习中心数据";
    settings.autoQuestion.apiKeySecret = "review-center-api-key";
    const stored = createSettingsSnapshot(settings, new Date("2026-09-20T09:00:00.000Z"));
    await writeSettingsMirror(h.adapter, stored);
    expect(await readSettingsMirror(h.adapter)).toEqual(stored);
    const raw = await readFile(join(h.root, SETTINGS_MIRROR_PATH), "utf8");
    expect(raw).toContain('"dataFolder": "99-附件/复习中心数据"');
    expect(raw).toContain('"apiKeySecret": "review-center-api-key"');
    expect(raw).not.toContain("sk-live-secret-value");
  });

  it("recovers from missing or revisionless plugin data using the stable mirror", () => {
    const custom = normalizeSettings(null);
    custom.dataFolder = "99-附件/复习中心数据";
    const mirror = createSettingsSnapshot(custom, new Date("2026-09-20T09:00:00.000Z"));
    expect(chooseStoredSettings(null, mirror)).toMatchObject({ source: "mirror", synchronize: true });
    const reset = { schemaVersion: 4, settings: normalizeSettings(null) };
    expect(chooseStoredSettings(reset, mirror)).toMatchObject({ source: "mirror", synchronize: true });
    expect(chooseStoredSettings(reset, mirror).data?.settings.dataFolder).toBe("99-附件/复习中心数据");
  });

  it("keeps matching settings and selects the newest valid divergent snapshot", () => {
    const settings = normalizeSettings(null);
    const older = createSettingsSnapshot(settings, new Date("2026-09-20T09:00:00.000Z"));
    const same = structuredClone(older);
    expect(chooseStoredSettings(older, same)).toMatchObject({ source: "primary", synchronize: false });
    same.settings.showCardHeatmap = false;
    expect(chooseStoredSettings(same, older)).toMatchObject({ source: "primary", synchronize: true });
    const newerPrimary = createSettingsSnapshot({ ...settings, dataFolder: "新目录" }, new Date("2026-09-20T10:00:00.000Z"));
    expect(chooseStoredSettings(newerPrimary, older)).toMatchObject({ source: "primary", synchronize: true });
    const newerMirror = createSettingsSnapshot({ ...settings, dataFolder: "镜像目录" }, new Date("2026-09-20T11:00:00.000Z"));
    expect(chooseStoredSettings(newerPrimary, newerMirror)).toMatchObject({ source: "mirror", synchronize: true });
  });

  it("rejects a damaged mirror instead of silently treating it as defaults", async () => {
    const h = await fixture();
    await h.adapter.write(SETTINGS_MIRROR_PATH, "{broken");
    await expect(readSettingsMirror(h.adapter)).rejects.toThrow("设置镜像无法读取");
  });
});
