import type { App } from "obsidian";
import { cloneValue } from "./utils";

// Presentation/session state is expendable. A browser storage failure must not
// make a successfully persisted rating look like a failed rating.
const volatile = new WeakMap<App, Map<string, unknown>>();
const warned = new WeakSet<App>();
function cache(app: App): Map<string, unknown> {
  let values = volatile.get(app);
  if (!values) { values = new Map(); volatile.set(app, values); }
  return values;
}
function warn(app: App): void {
  if (warned.has(app)) return;
  warned.add(app);
  console.warn("[渐进式复习] 本机会话暂时无法保存，重启后可按已有进度重新开始；知识库中的评分和排程不受影响。");
}
export function readLocalState(app: App, key: string): unknown {
  const values = cache(app);
  if (values.has(key)) return cloneValue(values.get(key));
  try {
    // Obsidian scopes this API by vault identity, including same-name vaults.
    const value: unknown = app.loadLocalStorage(`review-center:${key}`);
    return value;
  } catch { warn(app); return null; }
}
export function writeLocalState(app: App, key: string, value: unknown): boolean {
  const snapshot = cloneValue(value);
  cache(app).set(key, snapshot);
  try { app.saveLocalStorage(`review-center:${key}`, snapshot); return true; }
  catch { warn(app); return false; }
}
