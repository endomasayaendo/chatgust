import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig, type Config } from "./config.js";
import { TokenStore } from "./tokenStore.js";
import { createNotifier, buildReportPayload } from "./notifier.js";
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

const notifier = createNotifier(config.discordWebhookUrl);
const dispatcher = new AlertDispatcher(notifier, config.cooldownMin * 60 * 1000);

// --- 振り返り（レポート）系の配線 ---
const db = openDb(path.join(config.dataDir, "chatgust.db"));
const repo = new SqliteTimelineRepository(db);
repo.closeDangling(); // 前回異常終了で残った未終了セッションを確定

const recorder = new TimelineRecorder(repo, (s) =>
  notifier
    .sendReport(buildReportPayload(s, config.publicBaseUrl))
    .catch((err: Error) => console.error("[report]", err.message))
);

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
let syncTimer: ReturnType<typeof setInterval> | undefined;

const server = app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  streamSync.sync();
  syncTimer = setInterval(() => streamSync.sync(), POLL_INTERVAL_MS);
});

// --- 終了処理 ---
// Fly.io は既定で SIGINT、docker stop などは SIGTERM を送るため両方を同じ経路に通す。
// 配信中のセッションはここで確定してレポートを送る（送らずに落ちるとその配信の振り返り通知が失われる）。
// Fly の kill_timeout（既定 5 秒）で強制終了される前に終わるよう、送信の待ちは上限を設ける。
const SHUTDOWN_TIMEOUT_MS = 4_000;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // 2回目のシグナルは「待たずに止めたい」の意思表示として即終了する。
  if (shuttingDown) {
    console.log(`[shutdown] ${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received`);

  let exitCode = 0;
  try {
    clearInterval(syncTimer); // 終了処理中に新しい同期を始めない（実行中の同期の join は monitor が無視する）
    server.close(); // DB を閉じた後にレポート閲覧などのリクエストを受けない
    monitor.destroy(); // 検知・記録ループを止めてから確定する（確定後にサンプルが書かれないように）
    const reportsSent = recorder.finishAll(); // DB への確定はここで同期的に終わる
    db.close(); // WAL をチェックポイントして閉じる
    const timedOut = await Promise.race([
      reportsSent.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (timedOut) {
      console.error(`[shutdown] report sends did not finish within ${SHUTDOWN_TIMEOUT_MS}ms; some reports may be lost`);
    }
  } catch (err) {
    console.error("[shutdown] failed:", err);
    exitCode = 1;
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
