import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (value: string) => value, getAllTags: () => [] }));
import { ReviewService } from "../src/service";
import type { VaultScanner } from "../src/scanner";
import type { FullBackup } from "../src/types";
import type { ReviewStore } from "../src/storage";
import { fixtureRecord, fixtureSettings, reviewEvent, today } from "./fixtures";

describe("backup compatibility", () => {
  it("exports only the selected mode and deduplicates overlapping tag branches", async () => {
    const settings = fixtureSettings(), record = fixtureRecord("source", ["card/a", "card/b", "note"]);
    record.note.schedule.reps = 8;
    const store = { writeBackup: vi.fn(async () => "scope.json") };
    const service = new ReviewService({} as VaultScanner, store as unknown as ReviewStore, () => settings, "0.4.0", () => {});
    service.records = [record]; service.history = [reviewEvent("card"), reviewEvent("note", "source", "note")];
    service.history[0].beforeSchedule = structuredClone(record.cards["rv-one:qa"].schedule);
    service.history[0].durationMs = 12000;
    await service.exportScope({ mode: "card", groupId: "default-card", tagPath: "card/a" });
    const backup = (store.writeBackup.mock.calls as unknown as FullBackup[][])[0][0];
    expect(backup.kind).toBe("scope"); expect(backup.itemKeys).toEqual(["source::rv-one:qa"]);
    expect(backup.records[0].note.schedule.reps).toBe(0); expect(backup.history.map((e) => e.eventId)).toEqual(["card"]);
    expect(backup.settings.noteGroups).toEqual([]); expect(backup.settings.presets).toHaveLength(1);
    expect(backup.history[0].beforeSchedule).toEqual(record.cards["rv-one:qa"].schedule);
    expect(backup.history[0].durationMs).toBe(12000);
  });
  it("merges a scope, keeps conflicting local progress and does not import its history", async () => {
    const settings = fixtureSettings(), local = fixtureRecord(), incoming = structuredClone(local);
    incoming.cards["rv-one:qa"].schedule.reps = 10;
    const backup = { schemaVersion: 4, kind: "scope", scope: { mode: "card", groupId: "default-card" }, itemKeys: ["source::rv-one:qa"], settings, records: [incoming], history: [reviewEvent("foreign")] };
    const store = { readBackup: async () => backup, writeBackup: vi.fn(async () => "backup.json"), saveRecord: vi.fn(), appendHistory: vi.fn() };
    const service = new ReviewService({} as VaultScanner, store as unknown as ReviewStore, () => settings, "0.4.0", () => {});
    service.records = [local]; await service.restoreBackup("scope.json");
    expect(service.records[0].cards["rv-one:qa"].schedule.reps).toBe(0);
    expect(service.history).toEqual([]); expect(service.restoreConflicts).toHaveLength(1); expect(store.writeBackup).toHaveBeenCalledOnce();
  });
  it.each([1, 2, 3, 4])("restores v%s with a backup first and preserves identities and history", async (version) => {
    const settings = fixtureSettings();
    const record = fixtureRecord(); const event = reviewEvent("event");
    if (version === 4) { event.beforeSchedule = structuredClone(record.cards["rv-one:qa"].schedule); event.durationMs = 18000; }
    const importedSettings = version === 1 ? { watchedFolders: ["资料"], noteNewLimit: 4, cardRetention: 0.93 } : settings;
    const imported = { schemaVersion: version, exportedAt: today.toISOString(), pluginVersion: "0.1.0", settings: importedSettings, records: [record], history: [event] };
    const order: string[] = [];
    const store = { readBackup: vi.fn(async () => structuredClone(imported)), writeBackup: vi.fn(async (_backup: FullBackup) => { order.push("backup"); return "backup.json"; }),
      saveRecord: vi.fn(async () => { order.push("record"); }), deleteRecord: vi.fn(), replaceHistory: vi.fn(async () => { order.push("history"); }) };
    const service = new ReviewService({} as VaultScanner, store as unknown as ReviewStore, () => settings, "0.2.0", () => undefined);
    const restored = await service.restoreBackup("test.json");
    expect(order).toEqual(["backup", "record", "history"]);
    expect(service.records).toEqual([record]); expect(service.history).toEqual([event]);
    expect(store.writeBackup.mock.calls[0][0].schemaVersion).toBe(4);
    expect(restored.dataFolder).toBe(settings.dataFolder);
    if (version === 1) {
      expect(restored.noteGroups[0].tags).toEqual([]);
      expect(restored.noteGroups[0].parameters.newLimit).toBe(4);
      expect(restored.cardGroups[0].parameters.retention).toBe(0.93);
    } else expect(restored).toEqual(settings);
  });
});
