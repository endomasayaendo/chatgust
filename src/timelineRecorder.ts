import type { SessionObserver } from "./chatMonitor.js";
import type { TimelineRepository } from "./timelineRepository.js";

/** 配信終了時に reportSink へ渡す、確定したセッションの情報。 */
export interface FinishedSession {
  id: string;
  channel: string;
  title: string;
  startedAt: number;
  endedAt: number;
  peakRate: number;
}

interface ActiveSession {
  id: string;
  title: string;
  startedAt: number;
  peakRate: number;
}

/**
 * 振り返り機能の中核。ChatMonitor から配信のライフサイクル（onJoin/onSample/onPart）を受け取り、
 * TimelineRepository に流速サンプルを逐次貯める。配信終了時にはセッションを確定し、
 * reportSink（＝Discord へのレポート通知など）を呼ぶ。記録も通知もここで完結し、ChatMonitor は関知しない。
 */
export class TimelineRecorder implements SessionObserver {
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    private readonly repo: TimelineRepository,
    private readonly reportSink: (session: FinishedSession) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  onJoin(channel: string, title: string): void {
    if (this.active.has(channel)) return;
    const startedAt = this.now();
    const id = this.repo.startSession(channel, title, startedAt);
    this.active.set(channel, { id, title, startedAt, peakRate: 0 });
  }

  onSample(channel: string, rate: number): void {
    const session = this.active.get(channel);
    if (!session) return;
    // 時計が巻き戻っても経過時間が負にならないよう 0 で下限を取る。
    const t = Math.max(0, this.now() - session.startedAt);
    this.repo.addSample(session.id, t, rate);
    if (rate > session.peakRate) session.peakRate = rate;
  }

  onTitleChange(channel: string, title: string): void {
    const session = this.active.get(channel);
    if (!session) return;
    session.title = title;
    this.repo.updateTitle(session.id, title);
  }

  onPart(channel: string): void {
    const session = this.active.get(channel);
    if (!session) return;
    this.active.delete(channel);

    // 時計の巻き戻りで終了 < 開始 にならないよう下限を取る（配信時間が負になるのを防ぐ）。
    const endedAt = Math.max(this.now(), session.startedAt);
    this.repo.endSession(session.id, endedAt);
    this.reportSink({
      id: session.id,
      channel,
      title: session.title,
      startedAt: session.startedAt,
      endedAt,
      peakRate: session.peakRate,
    });
  }
}
