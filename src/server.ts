import express from "express";
import basicAuth from "express-basic-auth";
import path from "path";
import { fileURLToPath } from "url";
import type { ChatMonitor } from "./chatMonitor.js";
import type { AlertDispatcher } from "./alertDispatcher.js";
import type { Config } from "./config.js";
import type { TimelineRepository } from "./timelineRepository.js";
import { renderHtml } from "./reportRenderer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
  monitor: ChatMonitor;
  dispatcher: AlertDispatcher;
  config: Config;
  repo: TimelineRepository;
}

/**
 * ダッシュボードの静的ファイル配信と、監視状況・振り返りレポートを返すエンドポイントを備えた
 * Express アプリを構築して返す。DASHBOARD_PASSWORD が設定されていれば Basic 認証をかける。
 */
export function createServer({ monitor, dispatcher, config, repo }: ServerDeps): express.Application {
  const app = express();

  if (config.dashboardPassword) {
    app.use(basicAuth({ users: { admin: config.dashboardPassword }, challenge: true }));
  }

  app.use(express.static(path.join(__dirname, "../public")));

  app.get("/api/status", (_req, res) => {
    res.json({
      streams: monitor.getStatus(),
      recentAlerts: dispatcher.getRecentAlerts(),
      config: {
        spikeThreshold: config.spikeThreshold,
        spikeZ: config.spikeZ,
        minRate: config.minRate,
        cooldownMin: config.cooldownMin,
        notifyChannels: [...config.notifyChannels],
      },
    });
  });

  // 過去の配信レポート一覧（ダッシュボード用）
  app.get("/api/reports", (_req, res) => {
    res.json({ reports: repo.listReports(50) });
  });

  // 1配信ぶんの生データ（JSON）
  app.get("/api/reports/:id", (req, res) => {
    const session = repo.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(session);
  });

  // 振り返り波形（HTML）。Discord から届くリンクの着地点。
  app.get("/reports/:id", (req, res) => {
    const session = repo.getSession(req.params.id);
    if (!session) {
      res.status(404).send("レポートが見つかりません");
      return;
    }
    res.type("html").send(renderHtml(session));
  });

  return app;
}
