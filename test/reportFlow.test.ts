import { describe, it, expect, afterEach, vi } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository } from "../src/timelineRepository.js";
import { TimelineRecorder, type FinishedSession } from "../src/timelineRecorder.js";
import { ChatMonitor } from "../src/chatMonitor.js";
import type { IrcClient } from "../src/ircClient.js";
import type { SpikeDetector } from "../src/rateDetector.js";
import { createServer } from "../src/server.js";

/**
 * 開発環境で完結する結合テスト。
 * 実物の ChatMonitor → TimelineRecorder → SqliteTimelineRepository → createServer を通し、
 * 「配信終了(part)がレポート生成→HTTP配信まで繋がる」ランタイム経路を（Twitch I/O 抜きで）証明する。
 */

const cfg = { spikeThreshold: 8, minRate: 5, spikeZ: 3 };

// 受信も再接続もしない IRC スタブ（ネットワークI/Oを排除）
const stubIrc = { join() {}, part() {}, destroy() {} } as unknown as IrcClient;

// 一定の流速を返す検知器スタブ（スパイクは起こさない）
function stubDetectorFactory(rate: number): () => SpikeDetector {
  return () => ({
    addMessage() {},
    getRate: () => rate,
    getBaseline: () => 0,
    isSpike: () => false,
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  vi.useRealTimers();
});

describe("配信→記録→終了→レポート配信の結合", () => {
  it("part でレポートが生成され、/reports/:id で配信される", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    const repo = new SqliteTimelineRepository(openDb(":memory:"));
    const reports: FinishedSession[] = [];
    const recorder = new TimelineRecorder(repo, (s) => reports.push(s));

    const monitor = new ChatMonitor(() => {}, cfg, {
      irc: stubIrc,
      detectorFactory: stubDetectorFactory(12),
      observer: recorder,
    });

    // 配信開始 → 5秒tickを3回 → 配信終了
    monitor.join("demo", "デモ配信");
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(5000);
    monitor.part("demo");
    monitor.destroy();

    // レポートが確定し、集計が渡っている
    expect(reports).toHaveLength(1);
    const finished = reports[0];
    expect(finished.channel).toBe("demo");
    expect(finished.peakRate).toBe(12);
    expect(finished.id).toMatch(/^[0-9a-f]{12}$/);

    // DB にサンプルが 3 点貯まっている
    const session = repo.getSession(finished.id)!;
    expect(session.samples).toHaveLength(3);

    // 実物のサーバーがそのレポートを配信する（Discordリンクの着地点）
    vi.useRealTimers();
    const app = createServer({
      monitor: { getStatus: () => [] } as never,
      dispatcher: { getRecentAlerts: () => [] } as never,
      config: { dashboardPassword: undefined } as never,
      repo,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/reports/${finished.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("demo");
    expect(html).toContain("<polyline");
  });
});
