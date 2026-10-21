import type { SessionObserver } from "./chatMonitor.js";
import type { TimelineRepository } from "./timelineRepository.js";
import type { StreamRef } from "./vod.js";

/**
 * セッションが確定した理由。
 * - streamEnded: 配信が終わった（part）
 * - shutdown: 配信中に ChatGust 自体が終了した（記録は終了時点まで）
 */
export type EndReason = "streamEnded" | "shutdown";

/** セッション確定時に reportSink へ渡す、確定したセッションの情報。 */
export interface FinishedSession {
  id: string;
  channel: string;
  title: string;
  startedAt: number;
  endedAt: number;
  peakRate: number;
  /** ピーク流速を記録したサンプルの時刻（UTC ミリ秒）。流速が一度も 0 を超えなければ null。 */
  peakAt: number | null;
  endReason: EndReason;
  /** VOD リンク用の配信情報（不明なら null）。 */
  stream: StreamRef | null;
}

/** 確定したセッションの受け取り先。送信完了を待てるよう Promise を返してもよい。 */
export type ReportSink = (session: FinishedSession) => void | Promise<void>;

interface ActiveSession {
  id: string;
  title: string;
  startedAt: number;
  peakRate: number;
  peakAt: number | null;
  stream: StreamRef | null;
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
    private readonly reportSink: ReportSink,
    private readonly now: () => number = () => Date.now()
  ) {}

  onJoin(channel: string, title: string, stream?: StreamRef): void {
    if (this.active.has(channel)) return;
    const startedAt = this.now();
    const id = this.repo.startSession(channel, title, startedAt, stream);
    this.active.set(channel, {
      id,
      title,
      startedAt,
      peakRate: 0,
      peakAt: null,
      stream: stream ? { ...stream } : null,
    });
  }

  onSample(channel: string, rate: number): void {
    const session = this.active.get(channel);
    if (!session) return;
    // 時計が巻き戻っても経過時間が負にならないよう 0 で下限を取る。
    const t = Math.max(0, this.now() - session.startedAt);
    this.repo.addSample(session.id, t, rate);
    if (rate > session.peakRate) {
      session.peakRate = rate;
      session.peakAt = session.startedAt + t;
    }
  }

  onTitleChange(channel: string, title: string): void {
    const session = this.active.get(channel);
    if (!session) return;
    session.title = title;
    this.repo.updateTitle(session.id, title);
  }

  onVodFound(channel: string, vodId: string): void {
    const session = this.active.get(channel);
    if (!session?.stream) return;
    session.stream.vodId = vodId;
    this.repo.updateVodId(session.id, vodId);
  }

  onPart(channel: string): void {
    void this.finish(channel, "streamEnded");
  }

  /**
   * 稼働中の全セッションを確定する（プロセス終了時用）。
   * DB への確定は同期で済ませ、戻り値の Promise はレポート送信がすべて終わる（成否は問わない）と解決する。
   * 1件の確定・送信が失敗しても、残りのセッションは確定する。
   */
  finishAll(): Promise<void> {
    const finishing = [...this.active.keys()].map((channel) => this.finish(channel, "shutdown"));
    return Promise.all(finishing).then(() => undefined);
  }

  /**
   * セッションを確定し reportSink を呼ぶ。確定と sink の呼び出しは同期で行い、
   * 戻り値は sink の完了で解決する。失敗（同期の throw も非同期の reject も）はここでログし、reject しない。
   */
  private finish(channel: string, endReason: EndReason): Promise<void> {
    return new Promise<void>((resolve) => {
      const session = this.active.get(channel);
      if (!session) return resolve();
      this.active.delete(channel);

      // 時計の巻き戻りで終了 < 開始 にならないよう下限を取る（配信時間が負になるのを防ぐ）。
      const endedAt = Math.max(this.now(), session.startedAt);
      this.repo.endSession(session.id, endedAt);
      resolve(
        this.reportSink({
          id: session.id,
          channel,
          title: session.title,
          startedAt: session.startedAt,
          endedAt,
          peakRate: session.peakRate,
          peakAt: session.peakAt,
          endReason,
          stream: session.stream,
        })
      );
    }).catch((err: Error) => {
      console.error(`[timeline] finish #${channel} failed:`, err.message);
    });
  }
}
