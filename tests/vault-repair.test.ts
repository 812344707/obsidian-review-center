import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (path: string) => path }));
import { ReviewService } from "../src/service";
import type { ScanResult, VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import { fixtureRecord, fixtureSettings, reviewEvent } from "./fixtures";

function harness() {
  const record = fixtureRecord(), event = reviewEvent("old-rating", "source", "note");
  record.note = structuredClone(event.after!);
  const data: ScanResult = { records: [record], history: [event], conflicts: 0 };
  const order: string[] = [];
  const scanner = {
    loadStored: vi.fn(async () => structuredClone(data)),
    repair: vi.fn(async () => { order.push("repair"); return structuredClone(data); }),
  };
  const store = {
    flush: vi.fn(async () => {}),
    writeBackup: vi.fn(async () => { order.push("backup"); return "复习中心数据/exports/pre-repair.json"; }),
  };
  const service = new ReviewService(scanner as unknown as VaultScanner, store as unknown as ReviewStore, fixtureSettings, "1.0.0", () => {});
  service.records = structuredClone(data.records); service.history = structuredClone(data.history); service.hasLoaded = true;
  return { data, order, scanner, store, service };
}

describe("vault repair preserves review progress", () => {
  it("backs up the latest stored state before repairing and retains schedules and history", async () => {
    const h = harness();
    const result = await h.service.repair();
    expect(h.order).toEqual(["backup", "repair"]);
    expect(h.store.writeBackup).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 4, records: h.data.records, history: h.data.history,
    }), "pre-repair");
    expect(h.service.records).toEqual(h.data.records);
    expect(h.service.history).toEqual(h.data.history);
    expect(result).toMatchObject({ records: 1, issues: 0, backupPath: expect.stringContaining("pre-repair") });
    expect(h.service.maintenance).toBe(false);
  });

  it("does not repair if the backup fails and releases the maintenance lock", async () => {
    const h = harness();
    h.store.writeBackup.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.service.repair()).rejects.toThrow("disk full");
    expect(h.scanner.repair).not.toHaveBeenCalled();
    expect(h.service.records).toEqual(h.data.records);
    expect(h.service.maintenance).toBe(false);
  });

  it("blocks ratings and scans while repairing, then allows retry after an index failure", async () => {
    const h = harness();
    h.scanner.repair.mockResolvedValueOnce({ ...h.data, metadataReady: false });
    const repairing = h.service.repair();
    const blockedRating = h.service.gradeCurrent(3), blockedRefresh = h.service.refresh();
    await Promise.all([
      expect(blockedRating).rejects.toThrow("正在迁移"),
      expect(blockedRefresh).rejects.toThrow("正在迁移"),
      expect(repairing).rejects.toThrow("同步"),
    ]);
    expect(h.service.records).toEqual(h.data.records);
    expect(h.service.maintenance).toBe(false);
    await expect(h.service.repair()).resolves.toMatchObject({ records: 1 });
  });

  it("retains the session identity and reports sources needing manual review", async () => {
    const h = harness();
    h.service.startSession("card", false, "default-card");
    const before = structuredClone(h.service.session!);
    h.data.records[0].warnings = ["需要核对卡片格式"];
    const result = await h.service.repair();
    expect(h.service.session).toMatchObject({ id: before.id, entryKeys: before.entryKeys, currentIndex: before.currentIndex });
    expect(result.issues).toBe(1);
  });
});
