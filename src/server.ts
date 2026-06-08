import express from "express";
import basicAuth from "express-basic-auth";
import path from "path";
import { fileURLToPath } from "url";
import type { ChatMonitor } from "./chatMonitor.js";
import type { AlertDispatcher } from "./alertDispatcher.js";
import type { Config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerDeps {
  monitor: ChatMonitor;
  dispatcher: AlertDispatcher;
  config: Config;
}

/**
 * ダッシュボードの静的ファイル配信と、監視状況を返す /api/status エンドポイントを備えた
 * Express アプリを構築して返す。DASHBOARD_PASSWORD が設定されていれば Basic 認証をかける。
 */
export function createServer({ monitor, dispatcher, config }: ServerDeps): express.Application {
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

  return app;
}
