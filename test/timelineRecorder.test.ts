import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository } from "../src/timelineRepository.js";
import { TimelineRecorder, type FinishedSession } from "../src/timelineRecorder.js";

describe("TimelineRecorder", () => {
  let repo: SqliteTimelineRepository;
  let reports: FinishedSession[];
  let clock: number;
  let recorder: TimelineRecorder;

  beforeEach(() => {
    repo = new SqliteTimelineRepository(openDb(":memory:"));
    reports = [];
    clock = 1000;
    recorder = new TimelineRecorder(repo, (s) => reports.push(s), () => clock);
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
});
