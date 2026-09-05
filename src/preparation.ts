export interface PreparationProgress {
  percent: number;
  message: string;
}

export type ProgressReporter = (progress: PreparationProgress) => void;

/** Progress follows completed work; 100 is reserved for successful completion. */
export class PreparationTracker {
  private percent = 0;
  private yieldedAt = Date.now();

  constructor(private readonly report?: ProgressReporter) {}

  async step(from: number, to: number, completed: number, total: number, message: string): Promise<void> {
    this.percent = Math.max(this.percent, Math.min(99, Math.floor(from + (to - from) * (total ? completed / total : 1))));
    this.report?.({ percent: this.percent, message });
    if (this.report && Date.now() - this.yieldedAt >= 16) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.yieldedAt = Date.now();
    }
  }
}
