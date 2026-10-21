export class TwitchAuthError extends Error {
  constructor() {
    super("Twitch token expired (401)");
  }
}

export interface Stream {
  login: string;
  title: string;
  viewerCount: number;
  userId: string;
  /** 配信（1回のライブ）の id。アーカイブ VOD の stream_id と対応する。 */
  streamId: string;
  /** Twitch 上の配信開始時刻（UTC ミリ秒）。 */
  startedAt: number;
}

interface TwitchUser {
  id: string;
  login: string;
}

async function twitchGet<T>(clientId: string, token: string, url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) throw new TwitchAuthError();
  if (!res.ok) throw new Error(`Twitch API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function getCurrentUser(clientId: string, token: string): Promise<TwitchUser> {
  const data = await twitchGet<{ data: TwitchUser[] }>(
    clientId,
    token,
    "https://api.twitch.tv/helix/users"
  );
  if (!data.data[0]) throw new Error("No user returned from Twitch API — check token scopes");
  return data.data[0];
}

export async function getFollowedChannels(
  clientId: string,
  token: string,
  userId: string
): Promise<string[]> {
  const logins: string[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL("https://api.twitch.tv/helix/channels/followed");
    url.searchParams.set("user_id", userId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const data = await twitchGet<{
      data: { broadcaster_login: string }[];
      pagination?: { cursor?: string };
    }>(clientId, token, url.toString());

    logins.push(...data.data.map((c) => c.broadcaster_login));
    cursor = data.pagination?.cursor;
  } while (cursor);

  return logins;
}

export async function getLiveStreams(
  clientId: string,
  token: string,
  logins: string[]
): Promise<Stream[]> {
  if (logins.length === 0) return [];

  const streams: Stream[] = [];
  const CHUNK = 100;

  for (let i = 0; i < logins.length; i += CHUNK) {
    const chunk = logins.slice(i, i + CHUNK);
    const url = new URL("https://api.twitch.tv/helix/streams");
    chunk.forEach((l) => url.searchParams.append("user_login", l));

    const data = await twitchGet<{
      data: {
        id: string;
        user_id: string;
        user_login: string;
        title: string;
        viewer_count: number;
        started_at: string;
      }[];
    }>(clientId, token, url.toString());

    streams.push(
      ...data.data.map((s) => ({
        login: s.user_login,
        title: s.title,
        viewerCount: s.viewer_count,
        userId: s.user_id,
        streamId: s.id,
        startedAt: Date.parse(s.started_at),
      }))
    );
  }

  return streams;
}

/**
 * 配信（streamId）のアーカイブ VOD の id を返す。見つからなければ null
 * （VOD を保存しない設定のチャンネルや、アーカイブがまだ作られていない場合）。
 * 配信中のアーカイブは最新に来るため、直近の数件だけを見る。
 */
export async function getArchiveVideoId(
  clientId: string,
  token: string,
  userId: string,
  streamId: string
): Promise<string | null> {
  const url = new URL("https://api.twitch.tv/helix/videos");
  url.searchParams.set("user_id", userId);
  url.searchParams.set("type", "archive");
  url.searchParams.set("first", "5");

  const data = await twitchGet<{
    data: { id: string; stream_id: string | null }[];
  }>(clientId, token, url.toString());

  return data.data.find((v) => v.stream_id === streamId)?.id ?? null;
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string; refresh_token: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}
