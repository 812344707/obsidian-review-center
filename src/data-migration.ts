import type { DataAdapter } from "obsidian";
import { validateDataFolder } from "./config";
import { createId, hashText, pathIsInside } from "./utils";

interface CopyEntry { path: string; hashes: string[] }
interface MigrationJournal {
  version: 1;
  id: string;
  source: string;
  target: string;
  phase: "copying" | "verified" | "complete";
  entries: CopyEntry[];
}

async function digest(data: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureFolder(adapter: DataAdapter, path: string): Promise<void> {
  let current = "";
  for (const part of path.split("/")) {
    current = current ? current + "/" + part : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
    else if ((await adapter.stat(current))?.type !== "folder") throw new Error("路径中存在同名文件：" + current);
  }
}

async function filesUnder(adapter: DataAdapter, root: string): Promise<string[]> {
  if (!(await adapter.exists(root))) return [];
  const result: string[] = [];
  const pending = [root];
  while (pending.length) {
    const listing = await adapter.list(pending.pop()!);
    result.push(...listing.files);
    pending.push(...listing.folders);
  }
  return result.sort();
}

/** Caller holds the maintenance lock through copy and settings commit. Source cleanup is separately re-verified and recoverable. */
export async function copyDataDirectory(adapter: DataAdapter, sourceValue: string, targetValue: string): Promise<{
  source: string;
  target: string;
  complete: () => Promise<void>;
  trashSource: () => Promise<"system" | "local">;
}> {
  const source = validateDataFolder(sourceValue);
  const target = validateDataFolder(targetValue);
  if (source === target) return {
    source, target, complete: async () => undefined,
    trashSource: async () => { throw new Error("新旧数据目录相同，不能清理当前目录。"); },
  };
  if (pathIsInside(source, target) || pathIsInside(target, source)) throw new Error("新旧数据目录不能互相包含。");
  const journalPath = source + "/migrations/directory-" + hashText(target) + ".json";
  const markerPath = target + "/.review-center-migration.json";
  let prior: MigrationJournal | undefined;
  if (await adapter.exists(journalPath)) {
    prior = JSON.parse(await adapter.read(journalPath)) as MigrationJournal;
    if (prior.source !== source || prior.target !== target || prior.version !== 1) throw new Error("迁移记录无法核对，请选择另一空目录。");
  }
  const targetExists = await adapter.exists(target);
  if (targetExists && (await adapter.stat(target))?.type !== "folder") throw new Error("目标是文件，请选择文件夹。");
  const targetFiles = await filesUnder(adapter, target);
  if (targetExists) {
    const listing = await adapter.list(target);
    if (listing.files.length || listing.folders.length) {
      if (!prior || prior.phase === "complete" || !(await adapter.exists(markerPath))) throw new Error("目标目录不是空目录，不会覆盖已有内容。");
      const marker = JSON.parse(await adapter.read(markerPath)) as { id?: string };
      if (marker.id !== prior.id) throw new Error("目标目录不属于这次迁移，不会覆盖。");
    }
  }
  const priorEntries = new Map(prior?.entries.map((entry) => [entry.path, entry]) ?? []);
  for (const path of targetFiles) {
    if (path === markerPath) continue;
    const relative = path.slice(target.length + 1);
    const entry = priorEntries.get(relative);
    if (!entry || !entry.hashes.includes(await digest(await adapter.readBinary(path)))) {
      throw new Error("目标目录内容已被修改，停止覆盖：" + relative);
    }
  }
  const sourceFiles = (await filesUnder(adapter, source)).filter((path) => {
    const relative = path.slice(source.length + 1);
    return relative !== ".review-center-migration.json" && !/^migrations\/directory-/.test(relative);
  });
  const contents = new Map<string, ArrayBuffer>();
  const entries: CopyEntry[] = [];
  for (const path of sourceFiles) {
    const relative = path.slice(source.length + 1);
    const data = await adapter.readBinary(path);
    contents.set(relative, data);
    entries.push({ path: relative, hashes: [...new Set([...(priorEntries.get(relative)?.hashes ?? []), await digest(data)])] });
  }
  // Keep ownership of stale partial copies until their removal has completed.
  const journal: MigrationJournal = {
    version: 1, id: prior?.id ?? createId("migration"), source, target, phase: "copying",
    entries: [...entries, ...[...priorEntries.values()].filter((entry) => !contents.has(entry.path))],
  };
  await ensureFolder(adapter, source + "/migrations");
  await adapter.write(journalPath, JSON.stringify(journal, null, 2));
  await ensureFolder(adapter, target);
  await adapter.write(markerPath, JSON.stringify({ id: journal.id, source, target }));
  for (const path of targetFiles) {
    if (path !== markerPath && !contents.has(path.slice(target.length + 1))) await adapter.remove(path);
  }
  for (const [relative, data] of contents) {
    const path = target + "/" + relative;
    await ensureFolder(adapter, path.slice(0, path.lastIndexOf("/")));
    await adapter.writeBinary(path, data);
    const written = new Uint8Array(await adapter.readBinary(path));
    const expected = new Uint8Array(data);
    if (written.length !== expected.length || written.some((value, index) => value !== expected[index])) {
      throw new Error("数据复制核对失败，仍使用旧目录：" + relative);
    }
  }
  await assertSourceUnchanged(adapter, source, sourceFiles, contents, "迁移期间");
  journal.phase = "verified";
  journal.entries = entries;
  await adapter.write(journalPath, JSON.stringify(journal, null, 2));
  return {
    source,
    target,
    complete: async () => {
      journal.phase = "complete";
      await adapter.write(journalPath, JSON.stringify(journal, null, 2));
    },
    trashSource: async () => {
      // Sync can still write after the maintenance lock is released. Never trash a changed snapshot.
      await assertSourceUnchanged(adapter, source, sourceFiles, contents, "准备清理时");
      if (await adapter.trashSystem(source)) {
        if (await adapter.exists(source)) throw new Error("系统废纸篓操作后旧目录仍存在，请检查同步状态。");
        return "system";
      }
      await adapter.trashLocal(source);
      if (await adapter.exists(source)) throw new Error("知识库废纸篓操作后旧目录仍存在，请检查同步状态。");
      return "local";
    },
  };
}

async function assertSourceUnchanged(
  adapter: DataAdapter,
  source: string,
  sourceFiles: string[],
  contents: Map<string, ArrayBuffer>,
  phase: string,
): Promise<void> {
  const latestFiles = (await filesUnder(adapter, source)).filter((path) => {
    const relative = path.slice(source.length + 1);
    return relative !== ".review-center-migration.json" && !/^migrations\/directory-/.test(relative);
  });
  if (JSON.stringify(latestFiles) !== JSON.stringify(sourceFiles)) throw new Error(`${phase}旧目录文件发生变化，已保留旧目录，请重试。`);
  for (const [relative, data] of contents) {
    if (await digest(await adapter.readBinary(source + "/" + relative)) !== await digest(data)) {
      throw new Error(`${phase}旧数据发生变化，已保留旧目录，请重试。`);
    }
  }
}

/** Explicit cleanup for a directory the user has confirmed is no longer active. */
export async function trashInactiveDataDirectory(
  adapter: DataAdapter,
  activeValue: string,
  inactiveValue: string,
): Promise<"system" | "local"> {
  const active = validateDataFolder(activeValue);
  const inactive = validateDataFolder(inactiveValue);
  if (active === inactive) throw new Error("不能清理当前正在使用的复习数据目录。");
  if (pathIsInside(active, inactive) || pathIsInside(inactive, active)) throw new Error("当前目录与待清理目录不能互相包含。");
  if (!(await adapter.exists(inactive))) throw new Error("待清理的旧目录不存在。");
  if ((await adapter.stat(inactive))?.type !== "folder") throw new Error("待清理路径不是文件夹。");
  if (await adapter.trashSystem(inactive)) {
    if (await adapter.exists(inactive)) throw new Error("系统废纸篓操作后旧目录仍存在，请检查同步状态。");
    return "system";
  }
  await adapter.trashLocal(inactive);
  if (await adapter.exists(inactive)) throw new Error("知识库废纸篓操作后旧目录仍存在，请检查同步状态。");
  return "local";
}
