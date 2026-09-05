import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ TFile: class {}, normalizePath: (value: string) => value,
  getAllTags: (cache: { tags?: Array<{tag: string}>; frontmatter?: {tags?: string[]} }) =>
    [...(cache.tags ?? []).map((tag) => tag.tag), ...(cache.frontmatter?.tags ?? []).map((tag) => `#${tag}`)] }));
import type { App } from "obsidian";
import { VaultScanner } from "../src/scanner";
import type { ReviewStore } from "../src/storage";
import type { HistoryEvent, SourceRecord } from "../src/types";
import { fixtureSettings } from "./fixtures";
import { collectEntries } from "../src/queue";

function harness(tags = ["note", "card"]) {
  const settings = fixtureSettings();
  type File = { path: string; basename: string; stat: { ctime: number }; content: string; cache: Record<string, unknown> | null };
  const file: File = { path: "资料/测试.md", basename: "测试", stat: { ctime: Date.now() }, content: "## 复习\n\n问:: 问题\n答:: 答案\n", cache: { frontmatter: { tags } } };
  const files: File[] = [file];
  const records = new Map<string, SourceRecord>(); const history: HistoryEvent[] = [];
  const app = {
    vault: { getMarkdownFiles: () => files, read: async (file: File) => file.content,
      process: vi.fn(async (file: File, fn: (text: string) => string) => { file.content = fn(file.content); }) },
    metadataCache: { getFileCache: (file: File) => file.cache },
    fileManager: { processFrontMatter: vi.fn(async (file: File, fn: (value: object) => void) => fn(file.cache!.frontmatter as object)) },
  };
  const store = { sessionId: "s", deviceId: "d", initialize: async () => undefined,
    loadAllHistory: async () => structuredClone(history), loadAllRecords: async () => structuredClone([...records.values()]),
    saveRecord: vi.fn(async (record: SourceRecord) => { records.set(record.reviewId, structuredClone(record)); }),
    appendHistory: async (events: HistoryEvent[]) => { history.push(...structuredClone(events)); },
    writeBackup: vi.fn(async () => "backup.json"), backupSource: vi.fn(async () => undefined),
    deleteRecord: async (id: string) => { records.delete(id); } };
  const scanner = new VaultScanner(app as unknown as App, store as unknown as ReviewStore, () => settings);
  return { scanner, settings, app, store, records, history, file, files };
}

describe("tag scanner identity and scope", () => {
  it("does not rewrite unchanged snapshots or their timestamps on a repeat scan", async () => {
    const h = harness(); const before = await h.scanner.scan();
    h.store.saveRecord.mockClear();
    const result = await h.scanner.scan();
    expect(h.store.saveRecord).not.toHaveBeenCalled();
    expect(result.records).toEqual(before.records);
    expect(result.history).toEqual(before.history);
    (h.file.cache!.frontmatter as { tags: string[] }).tags = [];
    await h.scanner.scan();
    expect(h.store.saveRecord).toHaveBeenCalledOnce();
    h.store.saveRecord.mockClear();
    await h.scanner.scan();
    expect(h.store.saveRecord).not.toHaveBeenCalled();
  });
  it("assigns hidden body-card IDs once and preserves schedules across edits and rename", async () => {
    const h = harness();
    h.file.content = "Q: 正文问题\nA: 正文答案\n\n独立 {{c1::挖空}}。\n";
    const first = (await h.scanner.scan()).records[0];
    expect(h.file.content.match(/<!--review-center-id: rv-/g)).toHaveLength(2);
    const ids = Object.keys(first.cards).sort();
    expect(ids).toHaveLength(2);
    const schedules = Object.fromEntries(ids.map((id) => [id, structuredClone(first.cards[id].schedule)]));
    const textAfterFirstScan = h.file.content;
    h.file.path = "新目录/改名.md"; h.file.basename = "改名";
    const renamed = (await h.scanner.scan()).records[0];
    expect(h.file.content).toBe(textAfterFirstScan);
    expect(Object.keys(renamed.cards).sort()).toEqual(ids);
    for (const id of ids) expect(renamed.cards[id].schedule).toEqual(schedules[id]);
    h.file.content = h.file.content.replace("{{c1::挖空}}", "{{c1::挖空}} 和 {{c2::新增}} ");
    const expanded = (await h.scanner.scan()).records[0];
    const originalClozeId = ids.find((id) => id.endsWith(":c1"))!;
    expect(expanded.cards[originalClozeId].schedule).toEqual(schedules[originalClozeId]);
    expect(Object.keys(expanded.cards).filter((id) => id.endsWith(":c2"))).toHaveLength(1);
    h.file.content = h.file.content.replace("正文答案", "修改后的正文答案");
    const changed = (await h.scanner.scan()).records[0];
    const qaId = ids.find((id) => id.endsWith(":qa"))!;
    expect(changed.cards[qaId].status).toBe("pending-change");
    expect(changed.cards[originalClozeId].schedule).toEqual(schedules[originalClozeId]);
  });
  it("still persists changed cards and progress recovered from history", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    h.store.saveRecord.mockClear();
    const after = structuredClone(first.note); after.revision++; after.status = "suspended";
    h.history.push({ schemaVersion: 1, eventId: "remote-suspend", sessionId: "remote", deviceId: "other", sourceId: first.reviewId,
      itemId: "note", action: "suspend", occurredAt: new Date().toISOString(), baseRevision: first.note.revision, nextRevision: after.revision, after });
    const recovered = await h.scanner.scan();
    expect(recovered.records[0].note.status).toBe("suspended");
    expect(h.records.get(first.reviewId)?.note).toEqual(after);
    expect(h.store.saveRecord).toHaveBeenCalledOnce();
    h.store.saveRecord.mockClear();
    h.file.content = h.file.content.replace("答:: 答案", "答:: 新答案");
    const changed = await h.scanner.scan();
    expect(Object.values(changed.records[0].cards)[0].status).toBe("pending-change");
    expect(h.store.saveRecord).toHaveBeenCalledOnce();
  });
  it("reads property and inline tags and only parses cards when their scope matches", async () => {
    const h = harness(["note"]);
    let result = await h.scanner.scan();
    expect(result.records).toHaveLength(1);
    expect(Object.values(result.records[0].cards)).toHaveLength(0);
    expect(h.app.vault.process).not.toHaveBeenCalled();
    h.file.cache!.tags = [{ tag: "#CARD/inline" }];
    result = await h.scanner.scan();
    expect(Object.values(result.records[0].cards)).toHaveLength(1);
    expect(collectEntries(result.records, "card", h.settings)).toHaveLength(1);
  });
  it("preserves identities and schedules through rename, tag removal and re-entry", async () => {
    const h = harness();
    let result = await h.scanner.scan();
    const original = structuredClone(result.records[0]);
    h.file.path = "另一个文件夹/改名.md"; h.file.basename = "改名";
    result = await h.scanner.scan();
    expect(result.records[0].reviewId).toBe(original.reviewId);
    expect(result.records[0].cards).toEqual(original.cards);
    expect(result.records[0].sourcePath).toBe(h.file.path);
    (h.file.cache!.frontmatter as {tags: string[]}).tags = [];
    result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("out-of-scope");
    expect(result.records[0].cards).toEqual(original.cards);
    (h.file.cache!.frontmatter as {tags: string[]}).tags = ["note", "card"];
    result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("active");
    expect(result.records[0].cards).toEqual(original.cards);
    expect(h.history.filter((e) => e.action === "delete")).toHaveLength(0);
  });
  it("keeps existing data while metadata is unavailable and does not initialize unknown files", async () => {
    const h = harness(); await h.scanner.scan();
    const before = structuredClone([...h.records.values()]);
    h.file.cache = null;
    const result = await h.scanner.scan();
    expect(result.records).toEqual(before);
    expect(h.history.filter((e) => e.action === "delete")).toHaveLength(0);
    const empty = harness([]); await empty.scanner.scan();
    expect(empty.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
  });
  it("does not transfer an out-of-scope original's identity to its tagged copy", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    const copy = structuredClone(h.file); copy.path = "新目录/副本.md"; copy.basename = "副本";
    (h.file.cache!.frontmatter as {tags: string[]}).tags = [];
    h.files.push(copy);
    const result = await h.scanner.scan();
    expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.sourcePath === h.file.path)?.reviewId).toBe(first.reviewId);
    expect(result.records.find((r) => r.sourcePath === copy.path)?.reviewId).not.toBe(first.reviewId);
  });

  it("migrates known out-of-scope legacy notes without losing schedules or repeating conversion", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    h.file.content = h.file.content.replace("> [!review]- 复习", "## 复习").replace(/^> ?/gm, "");
    (h.file.cache!.frontmatter as { tags: string[] }).tags = [];
    const result = await h.scanner.scan();
    expect(h.file.content).toContain("> [!review]- 复习");
    expect(result.records[0].sourceStatus).toBe("out-of-scope");
    expect(result.records[0].cards).toEqual(first.cards);
    const backups = h.store.backupSource.mock.calls.length;
    await h.scanner.scan();
    expect(h.store.backupSource.mock.calls).toHaveLength(backups);
    expect(h.history.filter((event) => event.action === "delete")).toHaveLength(0);
  });
  it("keeps the original note and schedules on a failed migration backup, then retries", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    h.file.content = h.file.content.replace("> [!review]- 复习", "## 复习").replace(/^> ?/gm, "");
    const original = h.file.content;
    h.store.backupSource.mockRejectedValueOnce(new Error("disk error"));
    const failed = await h.scanner.scan();
    expect(h.file.content).toBe(original);
    expect(failed.records[0].cards).toEqual(first.cards);
    expect(failed.records[0].sourceStatus).toBe("parse-error");
    const retry = await h.scanner.scan();
    expect(retry.records[0].sourceStatus).toBe("active");
    expect(Object.keys(retry.records[0].cards)).toEqual(Object.keys(first.cards));
    expect(h.history.filter((event) => event.action === "delete")).toHaveLength(0);
  });
  it("does not delete progress when the ID remains in an unrecognized callout", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    h.file.content = h.file.content.replace("[!review]", "[!typo]");
    const result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("parse-error");
    expect(result.records[0].cards).toEqual(first.cards);
    expect(h.history.filter((event) => event.action === "delete")).toHaveLength(0);
  });
  it("leaves duplicate source identities untouched during legacy migration", async () => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    h.file.content = h.file.content.replace("> [!review]- 复习", "## 复习").replace(/^> ?/gm, "");
    const copy = structuredClone(h.file); copy.path = "资料/重复.md"; h.files.push(copy);
    const original = h.file.content;
    const result = await h.scanner.scan();
    expect(h.file.content).toBe(original); expect(copy.content).toBe(original);
    expect(copy.cache!.frontmatter).toEqual(h.file.cache!.frontmatter);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].cards).toEqual(first.cards);
    expect(result.records[0].warnings.join()).toContain("重复的笔记标识");
  });
  it.each(["missing-id", "changed-content"])("preserves unmatched saved cards in legacy migration: %s", async (change) => {
    const h = harness(); const first = (await h.scanner.scan()).records[0];
    h.file.content = h.file.content.replace("> [!review]- 复习", "## 复习").replace(/^> ?/gm, "");
    h.file.content = change === "missing-id" ? h.file.content.replace(/^\^rv-.*$/gm, "") : h.file.content.replace("答:: 答案", "答:: 修改后的答案");
    const original = h.file.content; const history = structuredClone(h.history);
    const result = await h.scanner.scan();
    expect(h.file.content).toBe(original);
    expect(result.records[0].cards).toEqual(first.cards);
    expect(result.records[0].warnings.join()).toContain("无法对应");
    expect(h.history).toEqual(history);
  });
  it("retains history after a real source deletion", async () => {
    const h = harness(); await h.scanner.scan(); const count = h.history.length;
    h.files.splice(0); const result = await h.scanner.scan();
    expect(result.records).toHaveLength(0);
    expect(h.history.length).toBeGreaterThan(count);
    expect(h.history.some((e) => e.action === "create")).toBe(true);
  });
  it("blocks malformed card sections without blocking note reviews or dropping cards", async () => {
    const h = harness(); const original = (await h.scanner.scan()).records[0];
    h.file.content += "\n> [!review]-\n> 问:: 缺少答案\n";
    const result = await h.scanner.scan();
    expect(result.records[0].sourceStatus).toBe("parse-error");
    expect(result.records[0].cards).toEqual(original.cards);
    expect(collectEntries(result.records, "note", h.settings)).toHaveLength(1);
    expect(collectEntries(result.records, "card", h.settings)).toHaveLength(0);
  });

});
