import { parseAllowlist } from "./notifyFilter.js";

/**
 * Twitch API の認証方式。
 * - user: `npm run auth` で得たユーザーアクセストークン。フォロー一覧を監視対象にできる
 * - app: Client ID / Secret から取るアプリアクセストークン。フォロー一覧は取れないので NOTIFY_CHANNELS を監視する
 */
export type AuthMode = "user" | "app";

/**
 * 認証方式を決める。ユーザートークンがあれば user、無くても監視対象を直接指定していれば app。
 * どちらも無ければ undefined（`npm run auth` が必要）。`make setup` の案内もこの判定を使う。
 */
export function resolveAuthMode(
  accessToken: string | undefined,
  notifyChannels: Set<string>
): AuthMode | undefined {
  if (accessToken) return "user";
  return notifyChannels.size > 0 ? "app" : undefined;
}

/**
 * アプリ全体で参照する、型付きの実行時設定。
 * 認証情報・通知設定・検知パラメータなど、環境変数由来の値をまとめて保持する。
 */
export interface Config {
  twitchClientId: string;
  twitchClientSecret: string;
  /** 未設定なら通知はコンソールに出力する（ConsoleNotifier）。 */
  discordWebhookUrl?: string;
  dashboardPassword?: string;
  notifyChannels: Set<string>;
  port: number;
  spikeThreshold: number;
  spikeZ: number;
  minRate: number;
  cooldownMin: number;
  authMode: AuthMode;
  accessToken: string;
  refreshToken: string;
  dataDir: string;
  publicBaseUrl: string;
}

/**
 * 以前の .env.example にあった Webhook の見本値。これのままだと Discord 送信が失敗ログになるだけで
 * 通知の中身が見えないため、未設定と同じに扱う（`make setup` を飛ばして起動した場合も拾う）。
 */
export const PLACEHOLDER_WEBHOOK_URL = "https://discord.com/api/webhooks/xxx/yyy";

/** 正の有限数であることを保証する。満たさなければ分かりやすいメッセージで throw。 */
function positiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: "${raw}". Must be a positive number.`);
  }
  return value;
}

/** 検知パラメータ（Config の一部）。バックテストも現行値の基準としてこれを使う。 */
export type DetectorSettings = Pick<Config, "spikeThreshold" | "spikeZ" | "minRate" | "cooldownMin">;

/** 環境変数から検知パラメータを読む（未設定なら既定値）。不正な数値は Error を投げる。 */
export function loadDetectorSettings(env: NodeJS.ProcessEnv = process.env): DetectorSettings {
  const { SPIKE_THRESHOLD = "8", SPIKE_Z = "3.0", MIN_RATE = "5", COOLDOWN_MIN = "5" } = env;
  return {
    spikeThreshold: positiveNumber(SPIKE_THRESHOLD, "SPIKE_THRESHOLD"),
    spikeZ: positiveNumber(SPIKE_Z, "SPIKE_Z"),
    minRate: positiveNumber(MIN_RATE, "MIN_RATE"),
    cooldownMin: positiveNumber(COOLDOWN_MIN, "COOLDOWN_MIN"),
  };
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
    REQUIRE_DISCORD_WEBHOOK,
    DASHBOARD_PASSWORD,
    NOTIFY_CHANNELS,
    TWITCH_ACCESS_TOKEN,
    TWITCH_REFRESH_TOKEN,
    PORT = "3000",
    DATA_DIR = "./data",
    PUBLIC_BASE_URL,
  } = env;

  const accessToken = TWITCH_ACCESS_TOKEN ?? "";
  const port = positiveNumber(PORT, "PORT");
  const notifyChannels = parseAllowlist(NOTIFY_CHANNELS);

  if (!TWITCH_CLIENT_ID) {
    throw new Error(
      "Missing required env vars. Copy .env.example to .env and fill in the values."
    );
  }

  // 空文字（.env に `DISCORD_WEBHOOK_URL=` と空で置かれる）と見本値は未設定扱いにする。
  const discordWebhookUrl =
    DISCORD_WEBHOOK_URL && DISCORD_WEBHOOK_URL !== PLACEHOLDER_WEBHOOK_URL ? DISCORD_WEBHOOK_URL : undefined;

  // 本番（fly.toml で指定）では、Webhook の設定漏れでコンソール出力に落ちて通知が黙って届かなくなるのを防ぐ。
  if (REQUIRE_DISCORD_WEBHOOK && !discordWebhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL is required (REQUIRE_DISCORD_WEBHOOK is set).");
  }

  const authMode = resolveAuthMode(accessToken, notifyChannels);
  if (!authMode) {
    throw new Error(
      "Missing Twitch login. Run `make auth` (or `npm run auth`), or set NOTIFY_CHANNELS to monitor specific channels without login."
    );
  }
  if (authMode === "app" && !TWITCH_CLIENT_SECRET) {
    throw new Error("TWITCH_CLIENT_SECRET is required to run without login (NOTIFY_CHANNELS mode).");
  }

  return {
    twitchClientId: TWITCH_CLIENT_ID,
    twitchClientSecret: TWITCH_CLIENT_SECRET ?? "",
    discordWebhookUrl,
    dashboardPassword: DASHBOARD_PASSWORD,
    notifyChannels,
    port,
    ...loadDetectorSettings(env),
    authMode,
    accessToken,
    refreshToken: TWITCH_REFRESH_TOKEN ?? "",
    // 空文字（.env に `DATA_DIR=` のように空で置かれる）も未設定扱いにするため || を使う。
    dataDir: DATA_DIR || "./data",
    // Discord のレポートリンクに使う公開URLの基点。未設定・空ならローカル前提の値にフォールバック。
    publicBaseUrl: PUBLIC_BASE_URL || `http://localhost:${port}`,
  };
}
