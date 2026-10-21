import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository } from "../src/timelineRepository.js";

function makeRepo() {
  return new SqliteTimelineRepository(openDb(":memory:"));
}

describe("SqliteTimelineRepository", () => {
  let repo: SqliteTimelineRepository;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("startSession は推測不能な id（12桁hex）を返す", () => {
    const id = repo.startSession("shroud", "PUBG", 1000);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("addSample を貯め、getSession が t 昇順で返す", () => {
    const id = repo.startSession("shroud", "PUBG", 1000);
    repo.addSample(id, 0, 3);
    repo.addSample(id, 5000, 7);
    repo.addSample(id, 10000, 5);

    const s = repo.getSession(id);
    expect(s).not.toBeNull();
    expect(s!.channel).toBe("shroud");
    expect(s!.title).toBe("PUBG");
    expect(s!.startedAt).toBe(1000);
    expect(s!.endedAt).toBeNull();
    expect(s!.samples).toEqual([
      { t: 0, rate: 3 },
      { t: 5000, rate: 7 },
      { t: 10000, rate: 5 },
    ]);
  });

  it("endSession で終了時刻が入る", () => {
    const id = repo.startSession("shroud", "PUBG", 1000);
    repo.endSession(id, 9999);
    expect(repo.getSession(id)!.endedAt).toBe(9999);
  });

  it("updateTitle でタイトルを更新する", () => {
    const id = repo.startSession("shroud", "旧タイトル", 1000);
    repo.updateTitle(id, "新タイトル");
    expect(repo.getSession(id)!.title).toBe("新タイトル");
  });

  it("存在しない id では null", () => {
    expect(repo.getSession("deadbeef")).toBeNull();
  });

  it("listReports は新しい順・サンプル数付きで返す", () => {
    const a = repo.startSession("a", "first", 1000);
    repo.addSample(a, 0, 1);
    const b = repo.startSession("b", "second", 2000);
    repo.addSample(b, 0, 1);
    repo.addSample(b, 5000, 2);

    const list = repo.listReports(10);
    expect(list.map((r) => r.channel)).toEqual(["b", "a"]); // started_at 降順
    expect(list[0].sampleCount).toBe(2);
    expect(list[1].sampleCount).toBe(1);
  });

  it("closeDangling は未終了セッションを最終サンプル時刻で閉じる", () => {
    const withSamples = repo.startSession("a", "t", 1000);
    repo.addSample(withSamples, 0, 1);
    repo.addSample(withSamples, 8000, 1);
    const empty = repo.startSession("b", "t", 5000);

    repo.closeDangling();

    expect(repo.getSession(withSamples)!.endedAt).toBe(1000 + 8000); // started_at + MAX(t)
    expect(repo.getSession(empty)!.endedAt).toBe(5000); // サンプル無し → started_at
  });

  it("closeDangling は既に終了済みのセッションを書き換えない", () => {
    const id = repo.startSession("a", "t", 1000);
    repo.endSession(id, 4242);
    repo.closeDangling();
    expect(repo.getSession(id)!.endedAt).toBe(4242);
  });
});

describe("配信情報（VOD）の永続化", () => {
  it("startSession の配信情報と updateVodId が getSession で返る", () => {
    const repo = makeRepo();
    const id = repo.startSession("a", "t", 1000, { streamId: "s1", startedAt: 500, vodId: null });
    expect(repo.getSession(id)!.stream).toEqual({ streamId: "s1", startedAt: 500, vodId: null });

    repo.updateVodId(id, "v1");
    expect(repo.getSession(id)!.stream).toEqual({ streamId: "s1", startedAt: 500, vodId: "v1" });
  });

  it("配信情報なしのセッションは stream=null", () => {
    const repo = makeRepo();
    const id = repo.startSession("a", "t", 1000);
    expect(repo.getSession(id)!.stream).toBeNull();
  });

  it("列追加前の既存 DB を開くと列が追加され、既存行は stream=null で読める", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "chatgust-db-"));
    try {
      const dbPath = path.join(dir, "old.db");
      // 列追加前のスキーマで作った DB（本番に既にあるもの）を再現する
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, channel TEXT NOT NULL, title TEXT NOT NULL,
          started_at INTEGER NOT NULL, ended_at INTEGER
        );
        CREATE TABLE samples (session_id TEXT NOT NULL, t INTEGER NOT NULL, rate INTEGER NOT NULL);
        INSERT INTO sessions (id, channel, title, started_at, ended_at) VALUES ('old1', 'a', 't', 1000, 2000);
      `);
      old.close();

      const db = openDb(dbPath);
      const repo = new SqliteTimelineRepository(db);
      expect(repo.getSession("old1")).toMatchObject({ id: "old1", endedAt: 2000, stream: null });

      const id = repo.startSession("b", "t", 3000, { streamId: "s1", startedAt: 2500, vodId: "v1" });
      expect(repo.getSession(id)!.stream).toEqual({ streamId: "s1", startedAt: 2500, vodId: "v1" });
      db.close();

      // 2回目以降の起動でも（列が既にあっても）落ちない
      openDb(dbPath).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
