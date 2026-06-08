import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { refreshAccessToken } from "./twitchApi.js";

type RefreshFn = (
  clientId: string,
  clientSecret: string,
  refreshToken: string
) => Promise<{ accessToken: string; refreshToken: string }>;

/**
 * Twitch のアクセストークンとリフレッシュトークンを保持し、
 * トークンの更新（リフレッシュ）と `.env` への永続化を担う。
 */
export class TokenStore {
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
