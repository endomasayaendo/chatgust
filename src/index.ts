import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { loadConfig, type Config } from "./config.js";
import { TokenStore } from "./tokenStore.js";
import { DiscordNotifier } from "./notifier.js";
import { AlertDispatcher } from "./alertDispatcher.js";
import { ChatMonitor } from "./chatMonitor.js";
import { StreamSync } from "./streamSync.js";
import { createServer } from "./server.js";

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

const monitor = new ChatMonitor(
  (channel, rate, baseline, title) => dispatcher.dispatch(channel, rate, baseline, title),
  { spikeThreshold: config.spikeThreshold, minRate: config.minRate, spikeZ: config.spikeZ }
);

const streamSync = new StreamSync(
  config.twitchClientId,
  tokenStore,
  monitor,
  config.notifyChannels
);

const app = createServer({ monitor, dispatcher, config });

// --- 起動 ---
const POLL_INTERVAL_MS = 60_000;

app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  streamSync.sync();
  setInterval(() => streamSync.sync(), POLL_INTERVAL_MS);
});

process.on("SIGINT", () => {
  monitor.destroy();
  process.exit(0);
});
