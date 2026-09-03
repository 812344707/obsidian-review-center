import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", () => ({ Modal: class {}, Setting: class {}, Notice: class {}, AbstractInputSuggest: class {}, TFolder: class {}, TFile: class {}, normalizePath: (v: string) => v, getAllTags: (c: { tags?: string[] }) => c.tags ?? [] }));
import { runTagJob, type TagJob } from "../src/tag-operations";
import { runRescheduleJob, type RescheduleJob, schedulingSignature } from "../src/reschedule";
import { fixtureRecord, fixtureSettings, today } from "./fixtures";
import { ReviewStore } from "../src/storage";
import type ReviewCenterPlugin from "../src/main";
import type { App } from "obsidian";
import { createHistoryEvent } from "../src/history";

function tagHost() {
  const settings = fixtureSettings(), files = [{ path: "a.md", text: "#old" }, { path: "b.md", text: "#old" }];
  settings.cardGroups[0].tags = ["old"];
  const checkpoints: unknown[] = [];
  const host = { settings, manifest: { version: "0.4" },
    app: { vault: { getMarkdownFiles: () => files, read: async (f: typeof files[0]) => f.text, process: async (f: typeof files[0], fn: (s: string) => string) => { f.text = fn(f.text); } }, metadataCache: { getFileCache: (f: typeof files[0]) => ({ tags: [f.text] }) } },
    service: { records: [], history: [], session: null, runMaintenance: async (fn: () => Promise<void>) => fn() },
    store: { writeBackup: vi.fn(async () => "backup.json"), saveJob: vi.fn(async (_id, value) => { checkpoints.push(structuredClone(value)); }) },
    persistSettingsInMaintenance: vi.fn(async (value) => { host.settings = value; }), refreshData: vi.fn(),
  };
  const job: TagJob = { kind: "tags", state: "pending", createdAt: today.toISOString(), operation: { from: "old", to: "new" }, files: files.map((f) => ({ path: f.path, original: "#old", next: "#new", selected: true, changes: ["#old → #new"] })) };
  return { host, files, job, checkpoints };
}
describe("recoverable operations", () => {
  it("backs up before writing, skips edited files and retains old references", async () => {
    const h = tagHost(); h.files[1].text = "edited after preview";
    await runTagJob(h.host as unknown as ReviewCenterPlugin, "tags-test", h.job);
    expect(h.files.map((f) => f.text)).toEqual(["#new", "edited after preview"]);
    expect(h.job.state).toBe("pending"); expect(h.job.files[1].error).toContain("预览后");
    expect(h.host.settings.cardGroups[0].tags).toEqual(["old", "new"]);
    expect((h.checkpoints[0] as TagJob).files.every((f) => f.status === undefined)).toBe(true);
  });
  it("continues after a write-before-checkpoint interruption without writing twice", async () => {
    const h = tagHost(); h.job.backup = "backup.json"; h.files[0].text = "#new";
    await runTagJob(h.host as unknown as ReviewCenterPlugin, "tags-test", h.job);
    expect(h.job.files.every((f) => f.status === "done")).toBe(true); expect(h.host.settings.cardGroups[0].tags).toEqual(["new"]);
    await runTagJob(h.host as unknown as ReviewCenterPlugin, "tags-test", h.job);
    expect(h.files.map((f) => f.text)).toEqual(["#new", "#new"]);
  });
  it("does not modify notes if the backup fails", async () => {
    const h = tagHost(); h.host.store.writeBackup.mockRejectedValueOnce(new Error("disk full"));
    await expect(runTagJob(h.host as unknown as ReviewCenterPlugin, "tags-test", h.job)).rejects.toThrow("disk full");
    expect(h.files.map((f) => f.text)).toEqual(["#old", "#old"]);
  });
  it("resumes an already appended reschedule event without duplicating history", async () => {
    const settings = fixtureSettings(), record = fixtureRecord(), before = structuredClone(record.note), after = { ...before, revision: before.revision + 1, schedule: { ...before.schedule, due: "2026-10-01T00:00:00.000Z" } };
    const event = createHistoryEvent({ sourceId: record.reviewId, itemId: "note", sessionId: "s", deviceId: "d", action: "reschedule", baseRevision: before.revision, after });
    const host = { settings, service: { records: [record], history: [event], runMaintenance: async (fn: () => Promise<void>) => fn() }, store: { appendHistory: vi.fn(), saveRecord: vi.fn(), saveJob: vi.fn() }, persistSettingsInMaintenance: vi.fn(), refreshData: vi.fn() };
    const job: RescheduleJob = { kind: "reschedule", state: "pending", createdAt: today.toISOString(), settings, baseline: schedulingSignature(settings), backup: "backup", entries: [{ sourceId: record.reviewId, path: record.sourcePath, before, after, event }] };
    await runRescheduleJob(host as unknown as ReviewCenterPlugin, "job", job);
    expect(record.note).toEqual(after); expect(host.store.appendHistory).not.toHaveBeenCalled(); expect(job.state).toBe("done");
  });
  it("reads the last complete checkpoint after a truncated write", async () => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const adapter = { exists: async (p: string) => files.has(p) || dirs.has(p), mkdir: async (p: string) => { dirs.add(p); }, read: async (p: string) => files.get(p)!, write: async (p: string, v: string) => { files.set(p, v); }, list: async (p: string) => ({ files: [...files.keys()].filter((f) => f.slice(0, f.lastIndexOf("/")) === p), folders: [...dirs].filter((f) => f.slice(0, f.lastIndexOf("/")) === p) }) };
    const store = new ReviewStore({ vault: { adapter } } as unknown as App, fixtureSettings, "s", "d");
    await store.saveJob("job", { state: "first" }); await store.saveJob("job", { state: "second" });
    files.set("复习中心数据/operations/job/00000003.json", "{");
    expect((await store.loadJobs<{ state: string }>())[0].data.state).toBe("second");
  });
});
