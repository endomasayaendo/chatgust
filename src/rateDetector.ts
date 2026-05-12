const WINDOW_SECS = 30;
const BASELINE_SAMPLES = 10;
const MAX_HISTORY_MS = (BASELINE_SAMPLES + 1) * WINDOW_SECS * 1000;
const WARMUP_MS = 2 * 60 * 1000; // 2 minutes before alerts are allowed

export class RateDetector {
  private timestamps: number[] = [];
  private readonly startedAt = Date.now();

  addMessage(): void {
    const now = Date.now();
    this.timestamps.push(now);
    const cutoff = now - MAX_HISTORY_MS;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  getRate(): number {
    const cutoff = Date.now() - WINDOW_SECS * 1000;
    return this.timestamps.filter((t) => t > cutoff).length;
  }

  getBaseline(): number {
    const now = Date.now();
    const windowMs = WINDOW_SECS * 1000;
    let total = 0;
    for (let i = 1; i <= BASELINE_SAMPLES; i++) {
      const end = now - i * windowMs;
      const start = end - windowMs;
      total += this.timestamps.filter((t) => t >= start && t < end).length;
    }
    return total / BASELINE_SAMPLES;
  }

  isSpike(threshold: number, minRate: number): boolean {
    if (Date.now() - this.startedAt < WARMUP_MS) return false;
    const rate = this.getRate();
    if (rate < minRate) return false;
    const baseline = this.getBaseline();
    if (baseline < 1) return rate >= minRate * 2;
    return rate >= baseline * threshold;
  }
}
