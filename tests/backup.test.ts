import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (value: string) => value, getAllTags: () => [] }));
import { ReviewService } from "../src/service";
import type { VaultScanner } from "../src/scanner";
import type { FullBackup } from "../src/types";
import type { ReviewStore } from "../src/storage";
import { fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";

describe("backup compatibility", () => {
  it.each([1, 2, 3])("restores v%s with a backup first and preserves identities and history", async (version) => {
    const settings = fixtureSettings();
    const record = fixtureRecord(); const event = reviewEvent("event");
    const importedSettings = version === 1 ? { watchedFolders: ["资料"], noteNewLimit: 4, cardRetention: 0.93 } : settings;
    const imported = { schemaVersion: version, exportedAt: today.toISOString(), pluginVersion: "0.1.0", settings: importedSettings, records: [record], history: [event] };
    const order: string[] = [];
    const store = { readBackup: vi.fn(async () => structuredClone(imported)), writeBackup: vi.fn(async (_backup: FullBackup) => { order.push("backup"); return "backup.json"; }),
      saveRecord: vi.fn(async () => { order.push("record"); }), deleteRecord: vi.fn(), replaceHistory: vi.fn(async () => { order.push("history"); }) };
    const service = new ReviewService({} as VaultScanner, store as unknown as ReviewStore, () => settings, "0.2.0", () => undefined);
    const restored = await service.restoreBackup("test.json");
    expect(order).toEqual(["backup", "record", "history"]);
    expect(service.records).toEqual([record]); expect(service.history).toEqual([event]);
    expect(store.writeBackup.mock.calls[0][0].schemaVersion).toBe(3);
    expect(restored.dataFolder).toBe(settings.dataFolder);
    if (version === 1) {
      expect(restored.noteGroups[0].tags).toEqual([]);
      expect(restored.noteGroups[0].parameters.newLimit).toBe(4);
      expect(restored.cardGroups[0].parameters.retention).toBe(0.93);
    } else expect(restored).toEqual(settings);
  });
});
