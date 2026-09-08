import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { readLocalState, writeLocalState } from "../src/local-state";

function appState(id: string, disk = new Map<string, unknown>()) {
  const app = {
    vault: { getName: () => "同名知识库" },
    loadLocalStorage: vi.fn((key: string) => disk.get(id + ":" + key) ?? null),
    saveLocalStorage: vi.fn((key: string, value: unknown) => { disk.set(id + ":" + key, value); }),
  };
  return { app: app as unknown as App, raw: app, disk };
}
describe("vault-local presentation and session state", () => {
  it("isolates same-name vaults and survives a vault rename and plugin reload", () => {
    const first = appState("first"), second = appState("second", first.disk);
    writeLocalState(first.app, "session", { id: "one", currentIndex: 2 });
    writeLocalState(second.app, "session", { id: "two", currentIndex: 5 });
    const reloaded = appState("first", first.disk);
    reloaded.raw.vault.getName = () => "改名知识库";
    expect(readLocalState(reloaded.app, "session")).toEqual({ id: "one", currentIndex: 2 });
    expect(readLocalState(second.app, "session")).toEqual({ id: "two", currentIndex: 5 });
  });
  it("keeps the current session usable when storage is full, and can clear it", () => {
    const h = appState("unavailable");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.raw.saveLocalStorage.mockImplementation(() => { throw new Error("QuotaExceededError"); });
    expect(writeLocalState(h.app, "session", { currentIndex: 3 })).toBe(false);
    expect(readLocalState(h.app, "session")).toEqual({ currentIndex: 3 });
    expect(() => writeLocalState(h.app, "session", null)).not.toThrow();
    expect(readLocalState(h.app, "session")).toBeNull();
    expect(warning).toHaveBeenCalledOnce(); warning.mockRestore();
  });
  it("falls back on a storage read failure without importing another vault's legacy queue", () => {
    const h = appState("read-failure");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.raw.loadLocalStorage.mockImplementation(() => { throw new Error("SecurityError"); });
    expect(readLocalState(h.app, "session")).toBeNull();
    writeLocalState(h.app, "session", { currentIndex: 0 });
    const first = readLocalState(h.app, "session") as { currentIndex: number };
    first.currentIndex = 9;
    expect(readLocalState(h.app, "session")).toEqual({ currentIndex: 0 });
    warning.mockRestore();
  });
});
