import { RateDetector, type SpikeDetector } from "./rateDetector.js";
import { IrcClient } from "./ircClient.js";
import { ConsecutiveSpikePolicy, type SpikePolicy } from "./spikePolicy.js";

export type AlertCallback = (
  channel: string,
  rate: number,
  baseline: number,
  title: string
) => void;

export interface DetectorConfig {
  spikeThreshold: number;
  minRate: number;
  spikeZ: number;
}

interface ChannelState {
  detector: SpikeDetector;
  title: string;
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

  constructor(
    private readonly onAlert: AlertCallback,
    private readonly cfg: DetectorConfig,
    private readonly irc: IrcClient = new IrcClient((channel) =>
      this.channels.get(channel)?.detector.addMessage()
    ),
    private readonly policy: SpikePolicy = new ConsecutiveSpikePolicy(),
    private readonly detectorFactory: () => SpikeDetector = () => new RateDetector()
  ) {}

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const { spikeThreshold, minRate, spikeZ } = this.cfg;
      for (const [channel, state] of this.channels) {
        const isSpike = state.detector.isSpike(spikeThreshold, minRate, spikeZ);
        if (this.policy.confirm(channel, isSpike)) {
          this.onAlert(channel, state.detector.getRate(), state.detector.getBaseline(), state.title);
        }
      }
    }, CHECK_INTERVAL_MS);
  }

  join(channel: string, title: string): void {
    const existing = this.channels.get(channel);
    if (existing) {
      existing.title = title;
      return;
    }
    this.channels.set(channel, { detector: this.detectorFactory(), title });
    this.irc.join(channel);
    this.startTimer();
    console.log(`[IRC] Joined #${channel}`);
  }

  part(channel: string): void {
    if (!this.channels.delete(channel)) return;
    this.policy.forget(channel);
    this.irc.part(channel);
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
    if (this.timer) clearInterval(this.timer);
    this.channels.clear();
    this.irc.destroy();
  }
}
