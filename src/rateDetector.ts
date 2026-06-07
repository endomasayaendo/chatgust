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

  /** 直前 BASELINE_SAMPLES 個のウィンドウそれぞれのメッセージ件数。 */
  private getWindowCounts(): number[] {
    const now = Date.now();
    const windowMs = WINDOW_SECS * 1000;
    const counts: number[] = [];
    for (let i = 1; i <= BASELINE_SAMPLES; i++) {
      const end = now - i * windowMs;
      const start = end - windowMs;
      counts.push(this.timestamps.filter((t) => t >= start && t < end).length);
    }
    return counts;
  }

  getBaseline(): number {
    const counts = this.getWindowCounts();
    return counts.reduce((sum, c) => sum + c, 0) / BASELINE_SAMPLES;
  }

  private static stdDev(counts: number[], mean: number): number {
    const variance =
      counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
    return Math.sqrt(variance);
  }

  /**
   * スパイク判定。配信規模に依存しないよう、平常の「平均 + ばらつき(標準偏差)」を
   * 基準にした z スコアで判定する。ばらつきが極端に小さい場合は従来の乗算ルールに
   * フォールバックする。
   *
   * @param threshold 乗算フォールバックの倍率（SPIKE_THRESHOLD）
   * @param minRate   アラートに必要な最低件数
   * @param z         平均から何σ超えたらスパイクとみなすか（SPIKE_Z）
   */
  isSpike(threshold: number, minRate: number, z: number): boolean {
    if (Date.now() - this.startedAt < WARMUP_MS) return false;

    const rate = this.getRate();
    if (rate < minRate) return false;

    const counts = this.getWindowCounts();
    const baseline = counts.reduce((sum, c) => sum + c, 0) / BASELINE_SAMPLES;

    // 配信開始直後などベースラインがほぼ無い場合
    if (baseline < 1) return rate >= minRate * 2;

    // z スコア: 平常のばらつきを大きく超えたら検知（小規模〜大手まで同じ基準で効く）
    const sd = RateDetector.stdDev(counts, baseline);
    if (sd > 0 && rate >= baseline + z * sd) return true;

    // フォールバック: ばらつきが極端に小さいチャットでは従来の乗算ルール
    return rate >= baseline * threshold;
  }
}
