import { RateDetector, type SpikeDetector } from "./rateDetector.js";
import { IrcClient } from "./ircClient.js";
import { ConsecutiveSpikePolicy, type SpikePolicy } from "./spikePolicy.js";
import type { StreamRef } from "./vod.js";

export type AlertCallback = (
  channel: string,
  rate: number,
  baseline: number,
  title: string,
  stream?: StreamRef
) => void;

export interface DetectorConfig {
  spikeThreshold: number;
  minRate: number;
  spikeZ: number;
}

/**
 * 監視対象チャンネルのライフサイクル（配信の開始・流速サンプル・終了）を受け取る観察者。
 * ChatMonitor はこの極小インターフェースにのみ依存し、記録先・保存方式・通知手段は知らない。
 * 振り返り機能はこれを実装して「ためて見せる」責務を担う（通知系とは別系統）。
 */
export interface SessionObserver {
  onJoin(channel: string, title: string, stream?: StreamRef): void;
  onSample(channel: string, rate: number): void;
  /** 配信中にタイトルが変わったときに呼ばれる。 */
  onTitleChange(channel: string, title: string): void;
  /** join 後に配信のアーカイブ VOD が見つかったときに呼ばれる。 */
  onVodFound(channel: string, vodId: string): void;
  onPart(channel: string): void;
}

/** 何もしない観察者（観察者未指定時の既定）。 */
const NOOP_OBSERVER: SessionObserver = {
  onJoin() {},
  onSample() {},
  onTitleChange() {},
  onVodFound() {},
  onPart() {},
};

/** ChatMonitor の任意依存。省略時は本番向けの既定が使われる。 */
export interface ChatMonitorDeps {
  irc?: IrcClient;
  policy?: SpikePolicy;
  detectorFactory?: () => SpikeDetector;
  observer?: SessionObserver;
}

interface ChannelState {
  detector: SpikeDetector;
  title: string;
  stream?: StreamRef;
}

const CHECK_INTERVAL_MS = 5_000;

/**
 * 監視中チャンネルの状態を束ね、チャットの盛り上がり検知からアラート発火までを取り持つ。
 * チャンネルごとに検知器（SpikeDetector）を保持し、一定間隔でスパイク判定を行い、
 * SpikePolicy が発火を認めたものを onAlert で通知する。チャットの受信は IrcClient が担う。
 */
export class ChatMonitor {
  private readonly channels = new Map<string, ChannelState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly irc: IrcClient;
  private readonly policy: SpikePolicy;
  private readonly detectorFactory: () => SpikeDetector;
  private readonly observer: SessionObserver;

  constructor(
    private readonly onAlert: AlertCallback,
    private readonly cfg: DetectorConfig,
    deps: ChatMonitorDeps = {}
  ) {
    this.irc =
      deps.irc ??
      new IrcClient((channel) => this.channels.get(channel)?.detector.addMessage());
    this.policy = deps.policy ?? new ConsecutiveSpikePolicy();
    this.detectorFactory = deps.detectorFactory ?? (() => new RateDetector());
    this.observer = deps.observer ?? NOOP_OBSERVER;
  }

  /**
   * 観察者（振り返り記録系）の呼び出しを保護する。記録側で例外が起きても、
   * 検知・通知（別系統）を巻き添えにせず、ログして続行する。
   */
  private notifyObserver(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[timeline] ${label} failed:`, (err as Error).message);
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const { spikeThreshold, minRate, spikeZ } = this.cfg;
      for (const [channel, state] of this.channels) {
        const rate = state.detector.getRate();
        this.notifyObserver("onSample", () => this.observer.onSample(channel, rate));
        const isSpike = state.detector.isSpike(spikeThreshold, minRate, spikeZ);
        if (this.policy.confirm(channel, isSpike)) {
          this.onAlert(channel, rate, state.detector.getBaseline(), state.title, state.stream);
        }
      }
    }, CHECK_INTERVAL_MS);
  }

  /**
   * チャンネルの監視を始める。監視中のチャンネルに対して呼ぶと、タイトルや VOD の変化を反映する
   * （定期同期は毎回 join を呼ぶ）。stream は VOD リンク用の配信情報で、無ければリンクを出さない。
   */
  join(channel: string, title: string, stream?: StreamRef): void {
    // 破棄後の join（終了処理中に完了した同期など）で、IRC 接続や検知ループを復活させない。
    if (this.destroyed) return;
    const existing = this.channels.get(channel);
    if (existing) {
      if (existing.title !== title) {
        existing.title = title;
        this.notifyObserver("onTitleChange", () => this.observer.onTitleChange(channel, title));
      }
      // 別の配信（同じチャンネルで配信し直した等）の VOD を、今のセッションに付けないよう streamId で照合する。
      const vodId = stream?.vodId;
      if (
        existing.stream &&
        vodId &&
        stream.streamId === existing.stream.streamId &&
        existing.stream.vodId !== vodId
      ) {
        existing.stream = { ...existing.stream, vodId };
        this.notifyObserver("onVodFound", () => this.observer.onVodFound(channel, vodId));
      }
      return;
    }
    this.channels.set(channel, { detector: this.detectorFactory(), title, stream });
    this.irc.join(channel);
    this.notifyObserver("onJoin", () => this.observer.onJoin(channel, title, stream));
    this.startTimer();
    console.log(`[IRC] Joined #${channel}`);
  }

  part(channel: string): void {
    if (!this.channels.delete(channel)) return;
    this.policy.forget(channel);
    this.irc.part(channel);
    this.notifyObserver("onPart", () => this.observer.onPart(channel));
    console.log(`[IRC] Parted #${channel}`);
  }

  getStatus(): { channel: string; title: string; rate: number; baseline: number }[] {
    return Array.from(this.channels.entries()).map(([channel, state]) => ({
      channel,
      title: state.title,
      rate: state.detector.getRate(),
      baseline: state.detector.getBaseline(),
    }));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.channels.clear();
    this.irc.destroy();
  }
}
