import type { ReviewSectionParseResult } from "./types";

export interface ParseCacheEntry {
  key: string;
  contentHash: string;
  parserVersion: number;
  settingsSignature: string;
  result: ReviewSectionParseResult;
}

const DATABASE_NAME = "progressive-review-local-cache";
const STORE_NAME = "parsed-sources";

export interface ParseCacheBackend {
  get(key: string): Promise<ParseCacheEntry | undefined>;
  put(entry: ParseCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Rebuildable, device-local parsing cache. Review schedules and history never
 * enter this database, so a cache failure cannot change review progress.
 */
export class ParseCache {
  private unavailable = false;
  private backend?: Promise<ParseCacheBackend | null>;

  constructor(
    private readonly vaultKey: () => string,
    private readonly connect: () => Promise<ParseCacheBackend | null> = openIndexedDb,
  ) {}

  async getOrParse(
    sourceId: string,
    markdown: string,
    parserVersion: number,
    settingsSignature: string,
    parse: () => ReviewSectionParseResult,
  ): Promise<{ result: ReviewSectionParseResult; hit: boolean; contentHash: string }> {
    const contentHash = await sha256Text(markdown);
    if (!contentHash) return { result: parse(), hit: false, contentHash: "" };
    const key = `${this.vaultKey()}\u0000${sourceId}`;
    const backend = await this.open();
    if (!backend) return { result: parse(), hit: false, contentHash };
    try {
      const cached = await backend.get(key);
      if (cached && cached.contentHash === contentHash && cached.parserVersion === parserVersion &&
        cached.settingsSignature === settingsSignature) {
        return { result: structuredClone(cached.result), hit: true, contentHash };
      }
      const result = parse();
      const entry: ParseCacheEntry = { key, contentHash, parserVersion, settingsSignature, result: structuredClone(result) };
      await backend.put(entry);
      return { result, hit: false, contentHash };
    } catch (error) {
      console.warn("[渐进式复习] 本机解析缓存暂不可用，将直接解析材料。", error);
      return { result: parse(), hit: false, contentHash };
    }
  }

  async delete(sourceId: string): Promise<void> {
    const backend = await this.open();
    if (!backend) return;
    try {
      await backend.delete(`${this.vaultKey()}\u0000${sourceId}`);
    } catch (error) {
      console.warn("[渐进式复习] 无法清理已删除材料的本机解析缓存。", error);
    }
  }

  private open(): Promise<ParseCacheBackend | null> {
    if (this.unavailable) return Promise.resolve(null);
    if (this.backend) return this.backend;
    this.backend = this.connect().catch(() => { this.unavailable = true; return null; });
    return this.backend;
  }
}

export async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === "undefined") return "";
  const bytes = new TextEncoder().encode(value.replace(/\r\n/g, "\n"));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openIndexedDb(): Promise<ParseCacheBackend | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const opening = indexedDB.open(DATABASE_NAME, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    opening.onsuccess = () => {
      const database = opening.result;
      resolve({
        get: (key) => request<ParseCacheEntry | undefined>(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key)),
        put: async (entry) => {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).put(entry);
          await transactionDone(transaction);
        },
        delete: async (key) => {
          const transaction = database.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).delete(key);
          await transactionDone(transaction);
        },
      });
    };
    opening.onerror = () => resolve(null);
    opening.onblocked = () => resolve(null);
  });
}
