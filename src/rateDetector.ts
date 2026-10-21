const WINDOW_SECS = 30;
const BASELINE_SAMPLES = 10;
const MAX_HISTORY_MS = (BASELINE_SAMPLES + 1) * WINDOW_SECS * 1000;
const WARMUP_MS = 2 * 60 * 1000; // 2 minutes before alerts are allowed

/**
 * チャットの流速計測とスパイク判定を提供する検知器のインターフェース。
 * メッセージの記録、直近レート・ベースラインの取得、スパイク判定を担う。
 */
export interface SpikeDetector {
  addMessage(): void;
  getRate(): number;
  getBaseline(): number;
  isSpike(threshold: number, minRate: number, z: number): boolean;
}

export class RateDetector implements SpikeDetector {
  /**
   * 昇順に並んだ受信時刻。先頭 head 件は枝刈り済み（配列の詰め直しを毎回しないため）。
   * 件数は二分探索で数えるので、高流量でも addMessage は償却 O(1)、集計は O(log n)。
   */
  private timestamps: number[] = [];
  private head = 0;
  private readonly startedAt = Date.now();

  addMessage(): void {
    const now = Date.now();
    const last = this.timestamps[this.timestamps.length - 1];
    if (last === undefined || now >= last) {
      this.timestamps.push(now);
    } else {
      // 時計が巻き戻った場合も昇順を保つ（まれなので O(n) の挿入で構わない）
      this.timestamps.splice(this.upperBound(now), 0, now);
    }
    this.prune(now - MAX_HISTORY_MS);
  }

  /** cutoff 以下の時刻を捨てる。消費済みが半分を超えたら配列を詰め直す。 */
  private prune(cutoff: number): void {
    this.head = this.upperBound(cutoff);
    if (this.head > this.timestamps.length / 2) {
      this.timestamps = this.timestamps.slice(this.head);
      this.head = 0;
    }
  }

  /** x 以上の最初の位置（head 以降）。 */
  private lowerBound(x: number): number {
    let lo = this.head;
    let hi = this.timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timestamps[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** x より大きい最初の位置（head 以降）。 */
  private upperBound(x: number): number {
    let lo = this.head;
    let hi = this.timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timestamps[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  getRate(): number {
    const cutoff = Date.now() - WINDOW_SECS * 1000;
    return this.timestamps.length - this.upperBound(cutoff);
  }

  /** 直前 BASELINE_SAMPLES 個のウィンドウそれぞれのメッセージ件数。 */
  private getWindowCounts(): number[] {
    const now = Date.now();
    const windowMs = WINDOW_SECS * 1000;
    const counts: number[] = [];
    for (let i = 1; i <= BASELINE_SAMPLES; i++) {
      const end = now - i * windowMs;
      const start = end - windowMs;
      counts.push(this.lowerBound(end) - this.lowerBound(start));
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
