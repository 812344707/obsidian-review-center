import { Platform } from "obsidian";
import type ReviewCenterPlugin from "./main";
import type { ReviewCenterSettings, ReviewPreset } from "./types";
import { buildOptimizerInput } from "./optimizer-data";
declare const __OPTIMIZER_WORKER__: string;
declare const __OPTIMIZER_WASM__: string;
export interface OptimizerResult {
  weights?: number[]; samples: number;
  before?: { logLoss: number; rmseBins: number }; after?: { logLoss: number; rmseBins: number }; health?: { logLoss: number; rmseBins: number }; healthError?: string;
  recommended?: number; missingTime?: number; deckSize?: number;
  rows?: Array<{ retention: number; minutesPerDay: number; reviewsPerDay: number; remembered: number }>;
}
export function runOptimizer(host: ReviewCenterPlugin, settings: ReviewCenterSettings, preset: ReviewPreset, action: "optimize" | "retention", progress: (message: string) => void): { result: Promise<OptimizerResult>; cancel: () => void } {
  let cancel = () => {};
  const result = new Promise<OptimizerResult>((resolve, reject) => {
    if (Platform.isMobile) { reject(new Error("请在电脑端优化，手机可以使用保存后的参数。")); return; }
    try {
      const input = buildOptimizerInput(host.service.records, host.service.history, settings, preset, action);
      const eligible = input.samples.filter((s) => s.reviews.length > 1 && s.reviews.at(-1)!.delta_t > 0).length;
      if (eligible < 64) throw new Error(`至少需要 64 条跨日复习记录；当前有 ${eligible} 条。原参数保持不变。`);
      const url = URL.createObjectURL(new Blob([__OPTIMIZER_WORKER__], { type: "text/javascript" }));
      let worker: Worker;
      try { worker = new Worker(url); } catch (e) { URL.revokeObjectURL(url); throw e; }
      let settled = false;
      const done = (value?: OptimizerResult, error?: Error) => { if (settled) return; settled = true; worker.terminate(); URL.revokeObjectURL(url); if (error) reject(error); else resolve(value!); };
      worker.onmessage = (event: MessageEvent<{ progress?: number; message?: string; result?: OptimizerResult; error?: string }>) => {
        const message = event.data;
        if (message.result) done(message.result);
        else if (message.error) done(undefined, new Error(message.error));
        else if (message.message) progress(`${Math.round((message.progress ?? 0) * 100)}% · ${message.message}`);
      };
      worker.onerror = (event) => done(undefined, new Error(event.message || "后台计算中断，原参数未改变。"));
      cancel = () => done(undefined, new Error("计算已取消，原参数保持不变。"));
      host.register(() => cancel());
      worker.postMessage({ wasm: __OPTIMIZER_WASM__, input });
    } catch (e) { reject(e); }
  });
  return { result, cancel: () => cancel() };
}
