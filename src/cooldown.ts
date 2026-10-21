/**
 * キー（チャンネル）ごとの連投抑制。前回の許可から ms 経過するまで次を許可しない。
 * 本番の AlertDispatcher と、バックテスト（scripts/backtest.ts）で共有する。
 */
export class Cooldown {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly ms: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** クールダウンが明けていれば許可時刻を記録して true、まだなら false。 */
  tryAcquire(key: string): boolean {
    const last = this.last.get(key) ?? 0;
    if (this.now() - last < this.ms) return false;
    this.last.set(key, this.now());
    return true;
  }
}
