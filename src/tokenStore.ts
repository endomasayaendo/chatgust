import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { getAppAccessToken, refreshAccessToken } from "./twitchApi.js";

type RefreshFn = (
  clientId: string,
  clientSecret: string,
  refreshToken: string
) => Promise<{ accessToken: string; refreshToken: string }>;

/**
 * StreamSync が使うアクセストークンの取得元。
 * `accessToken` が空なら未取得で、`refresh()` で取得（失効時は取り直し）する。
 */
export interface AccessTokenSource {
  readonly accessToken: string;
  refresh(): Promise<void>;
}

/**
 * Twitch のユーザーアクセストークンとリフレッシュトークンを保持し、
 * トークンの更新（リフレッシュ）と `.env` への永続化を担う。
 */
export class TokenStore implements AccessTokenSource {
  private access: string;
  private refreshToken: string;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly envPath: string,
    accessToken: string,
    refreshToken: string,
    private readonly refreshFn: RefreshFn = refreshAccessToken
  ) {
    this.access = accessToken;
    this.refreshToken = refreshToken;
  }

  get accessToken(): string {
    return this.access;
  }

  /** リフレッシュトークンで新しいトークンを取得し、保持＆`.env` へ永続化する。 */
  async refresh(): Promise<void> {
    if (!this.clientSecret || !this.refreshToken) {
      throw new Error("Cannot refresh: TWITCH_CLIENT_SECRET or refresh token missing");
    }
    const result = await this.refreshFn(this.clientId, this.clientSecret, this.refreshToken);
    this.access = result.accessToken;
    this.refreshToken = result.refreshToken;
    await this.persist();
    console.log("[auth] Token refreshed");
  }

  private async persist(): Promise<void> {
    if (!existsSync(this.envPath)) {
      console.warn(
        "[auth] .env not found — tokens not persisted. On Fly.io, run: flyctl secrets set TWITCH_ACCESS_TOKEN=<new> TWITCH_REFRESH_TOKEN=<new>"
      );
      return;
    }
    let content = await readFile(this.envPath, "utf-8");
    content = content
      .replace(/^TWITCH_ACCESS_TOKEN=.*/m, `TWITCH_ACCESS_TOKEN=${this.access}`)
      .replace(/^TWITCH_REFRESH_TOKEN=.*/m, `TWITCH_REFRESH_TOKEN=${this.refreshToken}`);
    await writeFile(this.envPath, content);
  }
}

/**
 * client credentials で取得するアプリアクセストークンを保持する（NOTIFY_CHANNELS 指定時の認証なしモード用）。
 * Client ID / Secret があればいつでも取り直せるので、`.env` には永続化しない。
 */
export class AppTokenStore implements AccessTokenSource {
  private access = "";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchFn: (clientId: string, clientSecret: string) => Promise<string> = getAppAccessToken
  ) {}

  get accessToken(): string {
    return this.access;
  }

  /** アプリアクセストークンを（取り直して）保持する。 */
  async refresh(): Promise<void> {
    this.access = await this.fetchFn(this.clientId, this.clientSecret);
    console.log("[auth] App access token obtained");
  }
}
