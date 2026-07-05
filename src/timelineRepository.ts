import crypto from "crypto";
import type { Db } from "./db.js";

/** 波形の1点。t は配信（セッション）開始からの経過ミリ秒。 */
export interface Sample {
  t: number;
  rate: number;
}

/** ダッシュボード一覧向けの配信レポートの要約。 */
export interface ReportSummary {
  id: string;
  channel: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  sampleCount: number;
}

/** レポート描画（HTML/JSON）向けの、サンプル込みの配信セッション。 */
export interface SessionWithSamples {
  id: string;
  channel: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  samples: Sample[];
}

/**
 * 振り返りデータの永続化を担う抽象。配信（セッション）の開始・サンプル追記・終了、
 * および閲覧用の取得を提供する。実装差し替え（テスト用インメモリ等）を可能にする。
 */
export interface TimelineRepository {
  /** 配信の記録を開始し、生成した推測不能なセッション id を返す。 */
  startSession(channel: string, title: string, startedAt: number): string;
  /** 1点のサンプルを追記する。 */
  addSample(sessionId: string, t: number, rate: number): void;
  /** 配信の終了時刻を記録する。 */
  endSession(sessionId: string, endedAt: number): void;
  /** 配信中のタイトル変更を反映する。 */
  updateTitle(sessionId: string, title: string): void;
  /** 未終了（前回クラッシュ由来など）のセッションを、直近サンプル時刻で閉じる。 */
  closeDangling(): void;
  /** 新しい順にレポート要約を最大 limit 件返す。 */
  listReports(limit: number): ReportSummary[];
  /** id 指定でサンプル込みのセッションを返す（無ければ null）。 */
  getSession(id: string): SessionWithSamples | null;
}

interface SessionRow {
  id: string;
  channel: string;
  title: string;
  started_at: number;
  ended_at: number | null;
}

interface SummaryRow extends SessionRow {
  sample_count: number;
}

/** better-sqlite3 を用いた TimelineRepository の実装。 */
export class SqliteTimelineRepository implements TimelineRepository {
  private readonly insertSession;
  private readonly insertSample;
  private readonly updateEnd;
  private readonly updateTitleStmt;
  private readonly selectSession;
  private readonly selectSamples;
  private readonly selectSummaries;
  private readonly closeDanglingStmt;

  constructor(private readonly db: Db) {
    this.insertSession = db.prepare(
      "INSERT INTO sessions (id, channel, title, started_at) VALUES (?, ?, ?, ?)"
    );
    this.insertSample = db.prepare(
      "INSERT INTO samples (session_id, t, rate) VALUES (?, ?, ?)"
    );
    this.updateEnd = db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?");
    this.updateTitleStmt = db.prepare("UPDATE sessions SET title = ? WHERE id = ?");
    this.selectSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
    this.selectSamples = db.prepare(
      "SELECT t, rate FROM samples WHERE session_id = ? ORDER BY t ASC"
    );
    this.selectSummaries = db.prepare(`
      SELECT s.*, COUNT(sm.session_id) AS sample_count
      FROM sessions s
      LEFT JOIN samples sm ON sm.session_id = s.id
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `);
    // 未終了セッションを、そのセッションの最終サンプル時刻（started_at + MAX(t)）で閉じる。
    // サンプルが無ければ started_at をそのまま終了時刻にする。
    this.closeDanglingStmt = db.prepare(`
      UPDATE sessions SET ended_at = COALESCE(
        (SELECT started_at + MAX(t) FROM samples WHERE samples.session_id = sessions.id),
        started_at
      )
      WHERE ended_at IS NULL
    `);
  }

  startSession(channel: string, title: string, startedAt: number): string {
    const id = crypto.randomBytes(6).toString("hex");
    this.insertSession.run(id, channel, title, startedAt);
    return id;
  }

  addSample(sessionId: string, t: number, rate: number): void {
    this.insertSample.run(sessionId, t, rate);
  }

  endSession(sessionId: string, endedAt: number): void {
    this.updateEnd.run(endedAt, sessionId);
  }

  updateTitle(sessionId: string, title: string): void {
    this.updateTitleStmt.run(title, sessionId);
  }

  closeDangling(): void {
    this.closeDanglingStmt.run();
  }

  listReports(limit: number): ReportSummary[] {
    const rows = this.selectSummaries.all(limit) as SummaryRow[];
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      title: r.title,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      sampleCount: r.sample_count,
    }));
  }

  getSession(id: string): SessionWithSamples | null {
    const row = this.selectSession.get(id) as SessionRow | undefined;
    if (!row) return null;
    const samples = this.selectSamples.all(id) as Sample[];
    return {
      id: row.id,
      channel: row.channel,
      title: row.title,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      samples,
    };
  }
}
