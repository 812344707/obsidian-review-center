import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataAdapter } from "obsidian";
import { copyDataDirectory, trashInactiveDataDirectory } from "../src/data-migration";
import { validateDataFolder } from "../src/config";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-data-test-")); roots.push(root);
  let writeHook: ((path: string) => Promise<void>) | undefined;
  let systemTrash = true;
  const adapter = {
    exists: async (path: string) => { try { await stat(join(root, path)); return true; } catch { return false; } },
    stat: async (path: string) => { const s = await stat(join(root, path)); return { type: s.isDirectory() ? "folder" : "file" }; },
    mkdir: async (path: string) => { await mkdir(join(root, path)); },
    read: async (path: string) => readFile(join(root, path), "utf8"),
    write: async (path: string, data: string) => { await writeFile(join(root, path), data); },
    readBinary: async (path: string) => { const bytes = await readFile(join(root, path)); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    writeBinary: async (path: string, data: ArrayBuffer) => { if (writeHook) await writeHook(path); await writeFile(join(root, path), Buffer.from(data)); },
    remove: async (path: string) => { await rm(join(root, path)); },
    trashSystem: async (path: string) => {
      if (!systemTrash) return false;
      await rm(join(root, path), { recursive: true }); return true;
    },
    trashLocal: async (path: string) => {
      await mkdir(join(root, ".trash"), { recursive: true });
      await rename(join(root, path), join(root, ".trash", path.replaceAll("/", "-")));
    },
    list: async (path: string) => {
      const entries = await readdir(join(root, path), { withFileTypes: true });
      return { files: entries.filter((e) => e.isFile()).map((e) => path + "/" + e.name), folders: entries.filter((e) => e.isDirectory()).map((e) => path + "/" + e.name) };
    },
  } as unknown as DataAdapter;
  await mkdir(join(root, "old/records"), { recursive: true });
  await mkdir(join(root, "old/history"));
  await writeFile(join(root, "old/records/a.json"), '{"schedule":{"reps":9}}');
  await writeFile(join(root, "old/history/h.jsonl"), '{"eventId":"event"}\n');
  await writeFile(join(root, "old/binary.bin"), Buffer.from([0, 255, 128, 13]));
  return {
    root, adapter,
    hook: (fn?: (path: string) => Promise<void>) => { writeHook = fn; },
    useLocalTrash: () => { systemTrash = false; },
  };
}
describe("data directory migration", () => {
  it("copies exact bytes, verifies completion and moves the unchanged source to system trash", async () => {
    const h = await fixture();
    const migration = await copyDataDirectory(h.adapter, "old", "学习数据/new");
    expect(migration.target).toBe("学习数据/new");
    for (const file of ["records/a.json", "history/h.jsonl", "binary.bin"]) {
      expect(await readFile(join(h.root, "学习数据/new", file))).toEqual(await readFile(join(h.root, "old", file)));
    }
    await migration.complete();
    expect(await h.adapter.exists("old/records/a.json")).toBe(true);
    await expect(migration.trashSource()).resolves.toBe("system");
    expect(await h.adapter.exists("old")).toBe(false);
  });
  it("falls back to the vault trash when system trash is unavailable", async () => {
    const h = await fixture(); h.useLocalTrash();
    const migration = await copyDataDirectory(h.adapter, "old", "new");
    await migration.complete();
    await expect(migration.trashSource()).resolves.toBe("local");
    expect(await h.adapter.exists("old")).toBe(false);
  });
  it("resumes an interrupted copy, including changes made to the still-active source", async () => {
    const h = await fixture();
    h.hook(async (path) => { if (path.endsWith("records/a.json")) throw new Error("interrupted"); });
    await expect(copyDataDirectory(h.adapter, "old", "new")).rejects.toThrow("interrupted");
    await writeFile(join(h.root, "old/records/a.json"), '{"schedule":{"reps":10}}');
    await writeFile(join(h.root, "old/history/later.jsonl"), '{"eventId":"later"}\n');
    h.hook();
    await (await copyDataDirectory(h.adapter, "old", "new")).complete();
    expect(await h.adapter.read("new/records/a.json")).toContain('"reps":10');
    expect(await h.adapter.read("new/history/later.jsonl")).toContain("later");
  });
  it("refuses existing data, ancestry paths and foreign edits in partial copies", async () => {
    const h = await fixture();
    await mkdir(join(h.root, "occupied")); await writeFile(join(h.root, "occupied/keep"), "untouched");
    await expect(copyDataDirectory(h.adapter, "old", "occupied")).rejects.toThrow("不是空目录");
    await expect(copyDataDirectory(h.adapter, "old", "old/inside")).rejects.toThrow("不能互相包含");
    h.hook(async (path) => { if (path.endsWith("records/a.json")) throw new Error("interrupted"); });
    await expect(copyDataDirectory(h.adapter, "old", "new")).rejects.toThrow("interrupted");
    await writeFile(join(h.root, "new/binary.bin"), "edited by someone");
    h.hook();
    await expect(copyDataDirectory(h.adapter, "old", "new")).rejects.toThrow("已被修改");
    expect(await readFile(join(h.root, "occupied/keep"), "utf8")).toBe("untouched");
  });
  it("detects external source writes before allowing the path switch", async () => {
    const h = await fixture();
    h.hook(async () => { await writeFile(join(h.root, "old/records/a.json"), "changed externally"); });
    await expect(copyDataDirectory(h.adapter, "old", "new")).rejects.toThrow("旧数据发生变化");
  });
  it("refuses cleanup when sync changes the source after verification", async () => {
    const h = await fixture();
    const migration = await copyDataDirectory(h.adapter, "old", "new");
    await writeFile(join(h.root, "old/history/synced.jsonl"), "sync\n");
    await expect(migration.trashSource()).rejects.toThrow("准备清理时旧目录文件发生变化");
    expect(await h.adapter.exists("old")).toBe(true);
  });
  it("accepts only vault-relative non-traversing paths", () => {
    expect(validateDataFolder(" 学习数据/复习中心/ ")).toBe("学习数据/复习中心");
    for (const path of ["", "/", "/tmp/data", "../data", "data/../other", "a//b", "C:/data", "a\\b"]) expect(() => validateDataFolder(path)).toThrow();
  });
  it("trashes an explicitly selected inactive directory but protects the active tree", async () => {
    const h = await fixture();
    await mkdir(join(h.root, "active"));
    await expect(trashInactiveDataDirectory(h.adapter, "active", "active")).rejects.toThrow("当前正在使用");
    await expect(trashInactiveDataDirectory(h.adapter, "active", "active/old")).rejects.toThrow("互相包含");
    await expect(trashInactiveDataDirectory(h.adapter, "active", "missing")).rejects.toThrow("不存在");
    await expect(trashInactiveDataDirectory(h.adapter, "active", "old")).resolves.toBe("system");
    expect(await h.adapter.exists("old")).toBe(false);
  });
});
