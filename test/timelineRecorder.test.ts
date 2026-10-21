import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository } from "../src/timelineRepository.js";
import { TimelineRecorder, type FinishedSession } from "../src/timelineRecorder.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TimelineRecorder", () => {
  let repo: SqliteTimelineRepository;
  let reports: FinishedSession[];
  let clock: number;
  let recorder: TimelineRecorder;

  beforeEach(() => {
    repo = new SqliteTimelineRepository(openDb(":memory:"));
    reports = [];
    clock = 1000;
    recorder = new TimelineRecorder(
      repo,
      (s) => {
        reports.push(s);
      },
      () => clock
    );
  });

  it("onJoin→onSample×N→onPart で経過msと共にサンプルが貯まる", () => {
    recorder.onJoin("shroud", "PUBG"); // startedAt = 1000
    clock = 6000;
    recorder.onSample("shroud", 3); // t = 5000
    clock = 11000;
    recorder.onSample("shroud", 8); // t = 10000
    clock = 16000;
    recorder.onPart("shroud"); // endedAt = 16000

    expect(reports).toHaveLength(1);
    const s = repo.getSession(reports[0].id)!;
    expect(s.channel).toBe("shroud");
    expect(s.startedAt).toBe(1000);
    expect(s.endedAt).toBe(16000);
    expect(s.samples).toEqual([
      { t: 5000, rate: 3 },
      { t: 10000, rate: 8 },
    ]);
  });

  it("onPart で reportSink に集計（peakRate・時刻・id）が渡る", () => {
    recorder.onJoin("a", "title");
    clock = 5000;
    recorder.onSample("a", 4);
    clock = 9000;
    recorder.onSample("a", 9); // peak
    clock = 12000;
    recorder.onSample("a", 2);
    clock = 20000;
    recorder.onPart("a");

    expect(reports[0]).toMatchObject({
      channel: "a",
      title: "title",
      startedAt: 1000,
      endedAt: 20000,
      peakRate: 9,
      endReason: "streamEnded",
    });
    expect(reports[0].id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("onTitleChange で記録側のタイトルが更新され、レポートにも反映される", () => {
    recorder.onJoin("a", "旧タイトル");
    clock = 5000;
    recorder.onSample("a", 1);
    recorder.onTitleChange("a", "新タイトル");
    clock = 10000;
    recorder.onPart("a");

    expect(reports[0].title).toBe("新タイトル");
    expect(repo.getSession(reports[0].id)!.title).toBe("新タイトル");
  });

  it("同じチャンネルの二重 onJoin は新セッションを作らない", () => {
    recorder.onJoin("a", "title");
    recorder.onJoin("a", "title-changed");
    clock = 5000;
    recorder.onSample("a", 1);
    recorder.onPart("a");

    expect(reports).toHaveLength(1);
    expect(repo.listReports(10)).toHaveLength(1);
  });

  it("未 join のチャンネルへの onSample/onPart は無視する", () => {
    recorder.onSample("ghost", 5);
    recorder.onPart("ghost");
    expect(reports).toHaveLength(0);
    expect(repo.listReports(10)).toHaveLength(0);
  });

  it("onPart で reportSink が非同期に失敗しても、未処理の reject にせずログする", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const failing = new TimelineRecorder(repo, () => Promise.reject(new Error("network")), () => clock);
      failing.onJoin("a", "A");
      failing.onPart("a");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errSpy).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  describe("finishAll（プロセス終了時）", () => {
    it("稼働中の全セッションを endReason=shutdown で確定し、DB に終了時刻を記録する", async () => {
      recorder.onJoin("a", "A");
      recorder.onJoin("b", "B");
      clock = 5000;
      recorder.onSample("a", 3);
      clock = 9000;

      await recorder.finishAll();

      expect(reports.map((r) => r.channel).sort()).toEqual(["a", "b"]);
      expect(reports.every((r) => r.endReason === "shutdown")).toBe(true);
      for (const r of reports) {
        expect(repo.getSession(r.id)!.endedAt).toBe(9000);
      }
      // 確定済みなので、後から part が来ても二重に通知しない
      recorder.onPart("a");
      expect(reports).toHaveLength(2);
    });

    it("レポート送信（非同期）の完了を待ってから解決する", async () => {
      const sent: string[] = [];
      const slow = new TimelineRecorder(
        repo,
        (s) => new Promise<void>((resolve) => setTimeout(() => (sent.push(s.channel), resolve()), 10)),
        () => clock
      );
      slow.onJoin("a", "A");

      await slow.finishAll();

      expect(sent).toEqual(["a"]);
    });

    it("1件の送信が失敗しても、残りのセッションは確定・送信される（失敗はログ）", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const sent: string[] = [];
      const flaky = new TimelineRecorder(
        repo,
        (s) => {
          if (s.channel === "a") throw new Error("boom");
          sent.push(s.channel);
        },
        () => clock
      );
      flaky.onJoin("a", "A");
      flaky.onJoin("b", "B");

      await expect(flaky.finishAll()).resolves.toBeUndefined();

      expect(sent).toEqual(["b"]);
      const all = repo.listReports(10);
      expect(all).toHaveLength(2);
      expect(all.every((r) => r.endedAt !== null)).toBe(true);
      expect(errSpy).toHaveBeenCalled();
    });

    it("稼働中セッションが無ければ何もしない", async () => {
      await recorder.finishAll();
      expect(reports).toHaveLength(0);
    });
  });

  describe("配信情報（VOD）", () => {
    const stream = { streamId: "s1", startedAt: 0, vodId: null };

    it("ピーク時刻と配信情報をレポートに渡し、後から見つかった VOD も反映する", () => {
      recorder.onJoin("a", "A", stream);
      clock = 5000;
      recorder.onSample("a", 9); // peak
      clock = 9000;
      recorder.onSample("a", 9); // 同値は更新しない（最初の山を指す）
      recorder.onVodFound("a", "v1");
      clock = 12000;
      recorder.onPart("a");

      expect(reports[0]).toMatchObject({
        peakAt: 5000,
        stream: { streamId: "s1", startedAt: 0, vodId: "v1" },
      });
      expect(repo.getSession(reports[0].id)!.stream).toEqual({
        streamId: "s1",
        startedAt: 0,
        vodId: "v1",
      });
    });

    it("配信情報なしで join したら stream=null、サンプルが無ければ peakAt=null", () => {
      recorder.onJoin("a", "A");
      recorder.onVodFound("a", "v1"); // 照合できる配信情報が無いので無視
      recorder.onPart("a");

      expect(reports[0]).toMatchObject({ peakAt: null, stream: null });
      expect(repo.getSession(reports[0].id)!.stream).toBeNull();
    });
  });
});
