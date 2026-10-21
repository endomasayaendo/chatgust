import {
  getArchiveVideoId,
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
 * ユーザー情報・フォロー中チャンネル・ライブ配信・アーカイブ VOD の取得を提供する。
 */
export interface TwitchApi {
  getCurrentUser(clientId: string, token: string): Promise<{ id: string }>;
  getFollowedChannels(clientId: string, token: string, userId: string): Promise<string[]>;
  getLiveStreams(clientId: string, token: string, logins: string[]): Promise<Stream[]>;
  getArchiveVideoId(
    clientId: string,
    token: string,
    userId: string,
    streamId: string
  ): Promise<string | null>;
}

/** Twitch の本番 API（twitchApi.ts）を呼び出す既定の TwitchApi 実装。 */
export const defaultTwitchApi: TwitchApi = {
  getCurrentUser,
  getFollowedChannels,
  getLiveStreams,
  getArchiveVideoId,
};

/**
 * フォロー中チャンネルの取得 → 許可リストでの絞り込み → ライブ配信の取得 → ChatMonitor への
 * join/part 反映、という定期同期の責務を担う。トークン失効（401）を検知したら TokenStore に
 * リフレッシュを依頼し、次回サイクルでユーザー ID を取り直す。
 *
 * 各配信のアーカイブ VOD もここで引いて join に添える。アラート発火時に引くと通知が遅れるため、
 * 同期のついでに先回りして解決しておく。見つかるまで（VOD を保存しないチャンネルでは配信中ずっと）
 * 同期のたびに引き直す。
 */
export class StreamSync {
  private userId = "";
  /** streamId → 見つかった VOD の id。配信中のものだけを保持する。 */
  private readonly vodIds = new Map<string, string>();

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

      await this.resolveVods(token, live);

      for (const stream of live) {
        this.monitor.join(stream.login, stream.title, {
          streamId: stream.streamId,
          startedAt: stream.startedAt,
          vodId: this.vodIds.get(stream.streamId) ?? null,
        });
      }
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

  /**
   * まだ VOD が分かっていない配信について、アーカイブ VOD を並列に引いてキャッシュする。
   * VOD は付加情報なので、取得の失敗はログするだけで同期（join/part）は止めない。
   */
  private async resolveVods(token: string, live: Stream[]): Promise<void> {
    const liveIds = new Set(live.map((s) => s.streamId));
    for (const id of this.vodIds.keys()) {
      if (!liveIds.has(id)) this.vodIds.delete(id);
    }

    await Promise.all(
      live
        .filter((s) => !this.vodIds.has(s.streamId))
        .map(async (s) => {
          try {
            const vodId = await this.api.getArchiveVideoId(this.clientId, token, s.userId, s.streamId);
            if (vodId) this.vodIds.set(s.streamId, vodId);
          } catch (err) {
            console.error(`[sync] VOD lookup for #${s.login} failed:`, (err as Error).message);
          }
        })
    );
  }
}
