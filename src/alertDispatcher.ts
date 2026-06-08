import type { Notifier } from "./notifier.js";

export interface RecentAlert {
  channel: string;
  rate: number;
  baseline: number;
  at: string;
}

const MAX_RECENT = 50;

/**
 * アラートの発火を担う。クールダウンによる同チャンネルへの連投抑制、最近のアラート履歴の保持、
 * Notifier を通じた通知の送信を行う。通知先ごとの送信処理は Notifier 側が受け持つ。
 */
export class AlertDispatcher {
  private readonly cooldowns = new Map<string, number>();
  private readonly recentAlerts: RecentAlert[] = [];

  constructor(
    private readonly notifier: Notifier,
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** クールダウン経過後のみ、履歴を記録して通知を送る。 */
  dispatch(channel: string, rate: number, baseline: number, title: string): void {
    const last = this.cooldowns.get(channel) ?? 0;
    if (this.now() - last < this.cooldownMs) return;
    this.cooldowns.set(channel, this.now());

    const entry: RecentAlert = { channel, rate, baseline, at: new Date().toISOString() };
    this.recentAlerts.unshift(entry);
    if (this.recentAlerts.length > MAX_RECENT) this.recentAlerts.pop();

    const mult = (rate / Math.max(baseline, 1)).toFixed(1);
    console.log(`[alert] ${channel}: ${rate} msg/30s (${mult}x baseline)`);

    this.notifier
      .send({ channel, title, rate, baseline, streamUrl: `https://twitch.tv/${channel}` })
      .catch((err: Error) => console.error("[notifier]", err.message));
  }

  /** ダッシュボード表示用に、新しい順で最大 limit 件の履歴を返す。 */
  getRecentAlerts(limit = 20): RecentAlert[] {
    return this.recentAlerts.slice(0, limit);
  }
}
