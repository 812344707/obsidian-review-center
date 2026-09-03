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

/** Caller holds the maintenance lock until commit or failure. Sources are never removed. */
export async function copyDataDirectory(adapter: DataAdapter, sourceValue: string, targetValue: string): Promise<{
  target: string;
  complete: () => Promise<void>;
}> {
  const source = validateDataFolder(sourceValue);
  const target = validateDataFolder(targetValue);
  if (source === target) return { target, complete: async () => undefined };
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
  // An external sync client can write despite the local maintenance lock.
  const latestFiles = (await filesUnder(adapter, source)).filter((path) => {
    const relative = path.slice(source.length + 1);
    return relative !== ".review-center-migration.json" && !/^migrations\/directory-/.test(relative);
  });
  if (JSON.stringify(latestFiles) !== JSON.stringify(sourceFiles)) throw new Error("迁移期间旧目录文件发生变化，请重试。");
  for (const [relative, data] of contents) {
    if (await digest(await adapter.readBinary(source + "/" + relative)) !== await digest(data)) {
      throw new Error("迁移期间旧数据发生变化，仍使用旧目录，请重试。");
    }
  }
  journal.phase = "verified";
  journal.entries = entries;
  await adapter.write(journalPath, JSON.stringify(journal, null, 2));
  return {
    target,
    complete: async () => {
      journal.phase = "complete";
      await adapter.write(journalPath, JSON.stringify(journal, null, 2));
    },
  };
}
