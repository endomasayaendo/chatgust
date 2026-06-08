import {
  getCurrentUser,
  getFollowedChannels,
  getLiveStreams,
  TwitchAuthError,
  type Stream,
} from "./twitchApi.js";
import { filterChannels } from "./notifyFilter.js";
import type { ChatMonitor } from "./chatMonitor.js";
import type { TokenStore } from "./tokenStore.js";

/**
 * StreamSync が利用する Twitch API の操作群。
 * ユーザー情報・フォロー中チャンネル・ライブ配信の取得を提供する。
 */
export interface TwitchApi {
  getCurrentUser(clientId: string, token: string): Promise<{ id: string }>;
  getFollowedChannels(clientId: string, token: string, userId: string): Promise<string[]>;
  getLiveStreams(clientId: string, token: string, logins: string[]): Promise<Stream[]>;
}

/** Twitch の本番 API（twitchApi.ts）を呼び出す既定の TwitchApi 実装。 */
export const defaultTwitchApi: TwitchApi = {
  getCurrentUser,
  getFollowedChannels,
  getLiveStreams,
};

/**
 * フォロー中チャンネルの取得 → 許可リストでの絞り込み → ライブ配信の取得 → ChatMonitor への
 * join/part 反映、という定期同期の責務を担う。トークン失効（401）を検知したら TokenStore に
 * リフレッシュを依頼し、次回サイクルでユーザー ID を取り直す。
 */
export class StreamSync {
  private userId = "";

  constructor(
    private readonly clientId: string,
    private readonly tokenStore: TokenStore,
    private readonly monitor: ChatMonitor,
    private readonly notifyChannels: Set<string>,
    private readonly api: TwitchApi = defaultTwitchApi
  ) {}

  async sync(): Promise<void> {
    try {
      const token = this.tokenStore.accessToken;
      if (!this.userId) {
        const user = await this.api.getCurrentUser(this.clientId, token);
        this.userId = user.id;
      }
      const followed = await this.api.getFollowedChannels(this.clientId, token, this.userId);
      const targets = filterChannels(followed, this.notifyChannels);
      const live = await this.api.getLiveStreams(this.clientId, token, targets);

      const liveSet = new Set(live.map((s) => s.login));
      const currentSet = new Set(this.monitor.getStatus().map((s) => s.channel));

      for (const stream of live) this.monitor.join(stream.login, stream.title);
      for (const channel of currentSet) {
        if (!liveSet.has(channel)) this.monitor.part(channel);
      }

      console.log(`[sync] Monitoring ${liveSet.size} live streams`);
    } catch (err) {
      if (err instanceof TwitchAuthError) {
        console.log("[auth] Token expired, attempting refresh...");
        try {
          await this.tokenStore.refresh();
          this.userId = "";
        } catch (refreshErr) {
          console.error("[auth] Refresh failed:", (refreshErr as Error).message);
        }
        return;
      }
      console.error("[sync] Error:", (err as Error).message);
    }
  }
}
