import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig, type Config } from "./config.js";
import { TokenStore } from "./tokenStore.js";
import { DiscordNotifier, buildReportPayload } from "./notifier.js";
import { AlertDispatcher } from "./alertDispatcher.js";
import { ChatMonitor } from "./chatMonitor.js";
import { StreamSync } from "./streamSync.js";
import { createServer } from "./server.js";
import { openDb } from "./db.js";
import { SqliteTimelineRepository } from "./timelineRepository.js";
import { TimelineRecorder } from "./timelineRecorder.js";

// --- 設定の読み込み（不正なら終了するのはここだけ） ---
let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

if (config.notifyChannels.size > 0) {
  console.log(`[config] Notify allowlist: ${[...config.notifyChannels].join(", ")}`);
}

// 最後の砦：一過性の例外で常駐ボットが丸ごと落ちないよう、ログして生かし続ける
// （IRC 自動再接続・トークン自動リフレッシュと同じ「落ちにくく」の思想）。
process.on("uncaughtException", (err) => console.error("[fatal] uncaughtException:", err));
process.on("unhandledRejection", (reason) => console.error("[fatal] unhandledRejection:", reason));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "../.env");

// --- 依存の生成と配線（composition root） ---
const tokenStore = new TokenStore(
  config.twitchClientId,
  config.twitchClientSecret,
  ENV_PATH,
  config.accessToken,
  config.refreshToken
);

const notifier = new DiscordNotifier(config.discordWebhookUrl);
const dispatcher = new AlertDispatcher(notifier, config.cooldownMin * 60 * 1000);

// --- 振り返り（レポート）系の配線 ---
const db = openDb(path.join(config.dataDir, "chatgust.db"));
const repo = new SqliteTimelineRepository(db);
repo.closeDangling(); // 前回異常終了で残った未終了セッションを確定

const recorder = new TimelineRecorder(repo, (s) => {
  notifier
    .sendReport(buildReportPayload(s, config.publicBaseUrl))
    .catch((err: Error) => console.error("[report]", err.message));
});

const monitor = new ChatMonitor(
  (channel, rate, baseline, title) => dispatcher.dispatch(channel, rate, baseline, title),
  { spikeThreshold: config.spikeThreshold, minRate: config.minRate, spikeZ: config.spikeZ },
  { observer: recorder }
);

const streamSync = new StreamSync(
  config.twitchClientId,
  tokenStore,
  monitor,
  config.notifyChannels
);

const app = createServer({ monitor, dispatcher, config, repo });

// --- 起動 ---
const POLL_INTERVAL_MS = 60_000;

app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  streamSync.sync();
  setInterval(() => streamSync.sync(), POLL_INTERVAL_MS);
});

process.on("SIGINT", () => {
  monitor.destroy();
  db.close(); // WAL をチェックポイントして閉じる（稼働中セッションは次回起動の closeDangling が確定）
  process.exit(0);
});
