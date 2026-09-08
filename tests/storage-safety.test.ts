import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ normalizePath: (value: string) => value, TFile: class {}, getAllTags: () => [] }));
import type { App } from "obsidian";
import { ReviewStore } from "../src/storage";
import { ReviewService } from "../src/service";
import type { VaultScanner } from "../src/scanner";
import { fixtureRecord, fixtureSettings, reviewEvent } from "./fixtures";

function harness() {
  const files = new Map<string, string>(), folders = new Set<string>();
  const adapter = {
    exists: vi.fn(async (p: string) => files.has(p) || folders.has(p)),
    mkdir: vi.fn(async (p: string) => { folders.add(p); }),
    read: vi.fn(async (p: string) => files.get(p)!),
    write: vi.fn(async (p: string, value: string) => { files.set(p, value); }),
    append: vi.fn(async (p: string, value: string) => { files.set(p, (files.get(p) ?? "") + value); }),
    remove: vi.fn(async (p: string) => { files.delete(p); }),
    list: async (p: string) => ({ files: [...files.keys()].filter(f => f.slice(0, f.lastIndexOf("/")) === p), folders: [...folders].filter(f => f.slice(0, f.lastIndexOf("/")) === p) }),
  };
  const store = new ReviewStore({ vault: { adapter } } as unknown as App, fixtureSettings, "session", "device");
  return { files, adapter, store };
}

describe("persisted review data boundaries", () => {
  it("rejects a backup path escaping the exports directory before reading it", async () => {
    const h = harness();
    await expect(h.store.readBackup("复习中心数据/exports/../../other.json")).rejects.toThrow(/导出目录/);
    expect(h.adapter.read).not.toHaveBeenCalled();
  });
  it.each(["../outside", "a/b", "a\\b", "", "__proto__"])("rejects unsafe source ID %s before any file access", async id => {
    const h = harness();
    await expect(h.store.saveRecord(fixtureRecord(id))).rejects.toThrow(/标识|记录/);
    await expect(h.store.loadRecord(id, true)).rejects.toThrow(/标识|记录/);
    await expect(h.store.deleteRecord(id)).rejects.toThrow(/标识|记录/);
    expect(h.adapter.exists).not.toHaveBeenCalled();
    expect(h.adapter.write).not.toHaveBeenCalled();
    expect(h.adapter.remove).not.toHaveBeenCalled();
  });

  it.each(["{", "null", '{"schemaVersion":1,"reviewId":"broken"}'])("stops instead of treating a damaged snapshot as new content: %s", async content => {
    const h = harness(), record = fixtureRecord();
    await h.store.initialize(); await h.store.saveRecord(record);
    h.files.set(h.store.recordPath(record.reviewId), content);
    h.adapter.write.mockClear();
    await expect(h.store.loadAllRecords()).rejects.toThrow(/记录|进度/);
    expect(h.adapter.write).not.toHaveBeenCalled();
    expect(h.files.get(h.store.recordPath(record.reviewId))).toBe(content);
  });

  it("rejects a valid JSON history row with a mismatched item before reconciliation", async () => {
    const h = harness(), event = reviewEvent("event");
    await h.store.initialize(); await h.store.appendHistory([event]);
    const historyPath = [...h.files.keys()].find(p => p.endsWith(".jsonl"))!;
    event.after!.id = "other-card";
    h.files.set(historyPath, JSON.stringify(event) + "\n");
    await expect(h.store.loadAllHistory(undefined, true)).rejects.toThrow(/历史/);
  });

  it.each(["missing schedule", "invalid date", "mismatched card", "invalid history", "duplicate source"])("rejects %s before a restore changes local files", async problem => {
    const settings = fixtureSettings(), record = fixtureRecord(), event = reviewEvent("event");
    const backup = { schemaVersion: 4, settings, records: [record], history: [event] };
    if (problem === "missing schedule") Reflect.deleteProperty(record.note, "schedule");
    if (problem === "invalid date") record.note.schedule.due = "not-a-date";
    if (problem === "mismatched card") record.cards["rv-one:qa"].id = "other-card";
    if (problem === "invalid history") event.after!.schedule.state = 99;
    if (problem === "duplicate source") backup.records.push(structuredClone(record));
    const store = { readBackup: async () => backup, writeBackup: vi.fn(), saveRecord: vi.fn(), deleteRecord: vi.fn(), replaceHistory: vi.fn() };
    const service = new ReviewService({} as VaultScanner, store as unknown as ReviewStore, () => settings, "1.0.0", () => {});
    service.records = [fixtureRecord("keep")];
    await expect(service.restoreBackup("broken.json")).rejects.toThrow();
    for (const method of [store.writeBackup, store.saveRecord, store.deleteRecord, store.replaceHistory]) expect(method).not.toHaveBeenCalled();
    expect(service.records[0].reviewId).toBe("keep");
  });
});
