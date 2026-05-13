export class TwitchAuthError extends Error {
  constructor() {
    super("Twitch token expired (401)");
  }
}

export interface Stream {
  login: string;
  title: string;
  viewerCount: number;
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
      data: { user_login: string; title: string; viewer_count: number }[];
    }>(clientId, token, url.toString());

    streams.push(
      ...data.data.map((s) => ({
        login: s.user_login,
        title: s.title,
        viewerCount: s.viewer_count,
      }))
    );
  }

  return streams;
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
