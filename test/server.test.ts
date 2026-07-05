import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository } from "../src/timelineRepository.js";
import { createServer } from "../src/server.js";

let server: Server;
let baseUrl: string;
let reportId: string;

beforeAll(async () => {
  const repo = new SqliteTimelineRepository(openDb(":memory:"));
  reportId = repo.startSession("shroud", "PUBG ランク", 1_700_000_000_000);
  repo.addSample(reportId, 0, 3);
  repo.addSample(reportId, 5000, 20);
  repo.addSample(reportId, 10000, 8);
  repo.endSession(reportId, 1_700_000_000_000 + 15000);

  const app = createServer({
    monitor: { getStatus: () => [] } as never,
    dispatcher: { getRecentAlerts: () => [] } as never,
    config: { dashboardPassword: undefined } as never,
    repo,
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

describe("レポート系エンドポイント", () => {
  it("GET /api/reports は一覧を返す", async () => {
    const res = await fetch(`${baseUrl}/api/reports`);
    expect(res.status).toBe(200);
    const { reports } = (await res.json()) as { reports: { id: string; sampleCount: number }[] };
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe(reportId);
    expect(reports[0].sampleCount).toBe(3);
  });

  it("GET /api/reports/:id はサンプル込みの JSON を返す", async () => {
    const res = await fetch(`${baseUrl}/api/reports/${reportId}`);
    expect(res.status).toBe(200);
    const session = (await res.json()) as { channel: string; samples: unknown[] };
    expect(session.channel).toBe("shroud");
    expect(session.samples).toHaveLength(3);
  });

  it("GET /reports/:id は波形 HTML を返す", async () => {
    const res = await fetch(`${baseUrl}/reports/${reportId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("shroud");
    expect(html).toContain("<polyline");
  });

  it("存在しない id は 404", async () => {
    expect((await fetch(`${baseUrl}/reports/nope`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/reports/nope`)).status).toBe(404);
  });
});
