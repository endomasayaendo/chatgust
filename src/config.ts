import { parseAllowlist } from "./notifyFilter.js";

/**
 * アプリ全体で参照する、型付きの実行時設定。
 * 認証情報・通知設定・検知パラメータなど、環境変数由来の値をまとめて保持する。
 */
export interface Config {
  twitchClientId: string;
  twitchClientSecret: string;
  discordWebhookUrl: string;
  dashboardPassword?: string;
  notifyChannels: Set<string>;
  port: number;
  spikeThreshold: number;
  spikeZ: number;
  minRate: number;
  cooldownMin: number;
  accessToken: string;
  refreshToken: string;
  dataDir: string;
  publicBaseUrl: string;
}

/** 正の有限数であることを保証する。満たさなければ分かりやすいメッセージで throw。 */
function positiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: "${raw}". Must be a positive number.`);
  }
  return value;
}

/**
 * 環境変数から Config を構築する。必須項目の欠落や不正な数値は Error を投げる。
 * プロセス終了などの副作用は持たず、終了するかどうかの判断は呼び出し側に委ねる。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const {
    TWITCH_CLIENT_ID,
    TWITCH_CLIENT_SECRET,
    DISCORD_WEBHOOK_URL,
    DASHBOARD_PASSWORD,
    NOTIFY_CHANNELS,
    TWITCH_ACCESS_TOKEN,
    TWITCH_REFRESH_TOKEN,
    PORT = "3000",
    SPIKE_THRESHOLD = "8",
    SPIKE_Z = "3.0",
    MIN_RATE = "5",
    COOLDOWN_MIN = "5",
    DATA_DIR = "./data",
    PUBLIC_BASE_URL,
  } = env;

  const accessToken = TWITCH_ACCESS_TOKEN ?? "";
  const port = positiveNumber(PORT, "PORT");

  if (!TWITCH_CLIENT_ID || !accessToken || !DISCORD_WEBHOOK_URL) {
    throw new Error(
      "Missing required env vars. Copy .env.example to .env and fill in the values."
    );
  }

  return {
    twitchClientId: TWITCH_CLIENT_ID,
    twitchClientSecret: TWITCH_CLIENT_SECRET ?? "",
    discordWebhookUrl: DISCORD_WEBHOOK_URL,
    dashboardPassword: DASHBOARD_PASSWORD,
    notifyChannels: parseAllowlist(NOTIFY_CHANNELS),
    port,
    spikeThreshold: positiveNumber(SPIKE_THRESHOLD, "SPIKE_THRESHOLD"),
    spikeZ: positiveNumber(SPIKE_Z, "SPIKE_Z"),
    minRate: positiveNumber(MIN_RATE, "MIN_RATE"),
    cooldownMin: positiveNumber(COOLDOWN_MIN, "COOLDOWN_MIN"),
    accessToken,
    refreshToken: TWITCH_REFRESH_TOKEN ?? "",
    // 空文字（.env に `DATA_DIR=` のように空で置かれる）も未設定扱いにするため || を使う。
    dataDir: DATA_DIR || "./data",
    // Discord のレポートリンクに使う公開URLの基点。未設定・空ならローカル前提の値にフォールバック。
    publicBaseUrl: PUBLIC_BASE_URL || `http://localhost:${port}`,
  };
}
