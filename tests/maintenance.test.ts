import { describe, expect, it } from "vitest";
import { ReviewService } from "../src/service";
import type { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import { fixtureSettings } from "./fixtures";

describe("maintenance coordination", () => {
  it("waits for in-flight scans, blocks new writes, then resumes normal operation", async () => {
    const order: string[] = [];
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => { release = resolve; });
    const scanner = { scan: async () => { order.push("scan-start"); await scanning; order.push("scan-end"); return { records: [], history: [], conflicts: 0 }; } };
    const service = new ReviewService(scanner as unknown as VaultScanner, {} as ReviewStore, fixtureSettings, "0.3.0", () => undefined);
    const refresh = service.refresh();
    await Promise.resolve(); await Promise.resolve();
    const migration = service.runMaintenance(async () => { order.push("copy"); });
    await expect(service.gradeCurrent(3)).rejects.toThrow("正在迁移");
    await expect(service.refresh()).rejects.toThrow("正在迁移");
    expect(order).toEqual(["scan-start"]);
    release(); await refresh; await migration;
    expect(order).toEqual(["scan-start", "scan-end", "copy"]);
    expect(service.maintenance).toBe(false);
    expect(await service.gradeCurrent(3)).toBeNull();
  });
  it("releases the lock after failure without losing an active session", async () => {
    const service = new ReviewService({} as VaultScanner, {} as ReviewStore, fixtureSettings, "0.3.0", () => undefined);
    const session = { id: "s", mode: "card" as const, entryKeys: ["source::card"], currentIndex: 0, answerVisible: false, startedAt: new Date().toISOString() };
    service.restoreLocalSession(session);
    await expect(service.runMaintenance(async () => { throw new Error("copy failed"); })).rejects.toThrow("copy failed");
    expect(service.maintenance).toBe(false);
    expect(service.session).toEqual(session);
    await expect(service.runMaintenance(async () => 7)).resolves.toBe(7);
  });
});
