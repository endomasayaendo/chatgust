export const WINDOW_SECS = 30;
export const BASELINE_SAMPLES = 10;
const MAX_HISTORY_MS = (BASELINE_SAMPLES + 1) * WINDOW_SECS * 1000;
export const WARMUP_MS = 2 * 60 * 1000; // 2 minutes before alerts are allowed

/** スパイク判定のパラメータ。 */
export interface SpikeParams {
  /** 乗算フォールバックの倍率（SPIKE_THRESHOLD） */
  threshold: number;
  /** アラートに必要な最低件数（MIN_RATE） */
  minRate: number;
  /** 平均から何σ超えたらスパイクとみなすか（SPIKE_Z） */
  z: number;
}

function stdDev(counts: number[], mean: number): number {
  const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  return Math.sqrt(variance);
}

/**
 * スパイク判定の本体（純粋関数）。配信規模に依存しないよう、平常の「平均 + ばらつき(標準偏差)」を
 * 基準にした z スコアで判定する。ばらつきが極端に小さい場合は従来の乗算ルールにフォールバックする。
 * 本番の RateDetector と、記録済み流速を再生するバックテスト（scripts/backtest.ts）で共有する。
 *
 * @param rate         現在の30秒窓の件数
 * @param windowCounts 直前 BASELINE_SAMPLES 個の30秒窓それぞれの件数
 */
export function judgeSpike(rate: number, windowCounts: number[], { threshold, minRate, z }: SpikeParams): boolean {
  if (rate < minRate) return false;

  const baseline = windowCounts.reduce((sum, c) => sum + c, 0) / windowCounts.length;

  // 配信開始直後などベースラインがほぼ無い場合
  if (baseline < 1) return rate >= minRate * 2;

  // z スコア: 平常のばらつきを大きく超えたら検知（小規模〜大手まで同じ基準で効く）
  const sd = stdDev(windowCounts, baseline);
  if (sd > 0 && rate >= baseline + z * sd) return true;

  // フォールバック: ばらつきが極端に小さいチャットでは従来の乗算ルール
  return rate >= baseline * threshold;
}

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

  /**
   * スパイク判定。開始から WARMUP_MS の間は判定しない。判定の本体は judgeSpike。
   *
   * @param threshold 乗算フォールバックの倍率（SPIKE_THRESHOLD）
   * @param minRate   アラートに必要な最低件数
   * @param z         平均から何σ超えたらスパイクとみなすか（SPIKE_Z）
   */
  isSpike(threshold: number, minRate: number, z: number): boolean {
    if (Date.now() - this.startedAt < WARMUP_MS) return false;
    return judgeSpike(this.getRate(), this.getWindowCounts(), { threshold, minRate, z });
  }
}
