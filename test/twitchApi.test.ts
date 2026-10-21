import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getArchiveVideoId,
  getCurrentUser,
  getFollowedChannels,
  getLiveStreams,
  refreshAccessToken,
  TwitchAuthError,
} from "../src/twitchApi.js";

const CLIENT_ID = "cid";
const TOKEN = "tok";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Helix streams の1件（必要なフィールドのみ）。 */
function liveStream(login: string, title: string, viewers: number) {
  return {
    id: `stream-${login}`,
    user_id: `id-${login}`,
    user_login: login,
    title,
    viewer_count: viewers,
    started_at: "2026-10-21T12:00:00Z",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getCurrentUser", () => {
  it("401 のとき TwitchAuthError を投げる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(getCurrentUser(CLIENT_ID, TOKEN)).rejects.toBeInstanceOf(TwitchAuthError);
  });

  it("ユーザーが返らなければエラー", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(getCurrentUser(CLIENT_ID, TOKEN)).rejects.toThrow(/No user/);
  });

  it("正常時はユーザーを返し、認証ヘッダを付与する", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "42", login: "me" }] }));
    const user = await getCurrentUser(CLIENT_ID, TOKEN);
    expect(user).toEqual({ id: "42", login: "me" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Client-ID"]).toBe(CLIENT_ID);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("getFollowedChannels", () => {
  it("pagination.cursor を辿って全ページを結合する", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ broadcaster_login: "a" }, { broadcaster_login: "b" }],
          pagination: { cursor: "CUR1" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ broadcaster_login: "c" }], pagination: {} })
      );

    const result = await getFollowedChannels(CLIENT_ID, TOKEN, "uid");
    expect(result).toEqual(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 2回目の呼び出しは after=CUR1 を含む
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("after=CUR1");
  });
});

describe("getLiveStreams", () => {
  it("ログインが空なら fetch せず空配列", async () => {
    const result = await getLiveStreams(CLIENT_ID, TOKEN, []);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("100件超は100件チャンクに分割して取得する", async () => {
    const logins = Array.from({ length: 150 }, (_, i) => `u${i}`);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [liveStream("u0", "T0", 10)] })
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [liveStream("u100", "T100", 20)] })
      );

    const result = await getLiveStreams(CLIENT_ID, TOKEN, logins);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 1チャンク目は100件の user_login を含む
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    expect((firstUrl.match(/user_login=/g) ?? []).length).toBe(100);

    expect(result.map((s) => s.login)).toEqual(["u0", "u100"]);
  });

  it("VOD リンク用に stream id・user id・配信開始時刻（ミリ秒）を取り出す", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [liveStream("u0", "T0", 10)] }));

    const [s] = await getLiveStreams(CLIENT_ID, TOKEN, ["u0"]);

    expect(s).toEqual({
      login: "u0",
      title: "T0",
      viewerCount: 10,
      userId: "id-u0",
      streamId: "stream-u0",
      startedAt: Date.UTC(2026, 9, 21, 12, 0, 0),
    });
  });
});

describe("getArchiveVideoId", () => {
  it("アーカイブ VOD のうち stream_id が一致するものの id を返す", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: "v2", stream_id: "s2" },
          { id: "v1", stream_id: "s1" },
        ],
      })
    );

    expect(await getArchiveVideoId(CLIENT_ID, TOKEN, "uid", "s1")).toBe("v1");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/helix/videos");
    expect(url.searchParams.get("user_id")).toBe("uid");
    expect(url.searchParams.get("type")).toBe("archive");
  });

  it("一致する VOD が無ければ null（VOD を保存しないチャンネル）", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "v9", stream_id: "old" }] }));
    expect(await getArchiveVideoId(CLIENT_ID, TOKEN, "uid", "s1")).toBeNull();
  });
});

describe("refreshAccessToken", () => {
  it("refresh_token グラントで POST し新トークンを返す", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "newA", refresh_token: "newR" })
    );

    const result = await refreshAccessToken(CLIENT_ID, "secret", "oldR");
    expect(result).toEqual({ accessToken: "newA", refreshToken: "newR" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://id.twitch.tv/oauth2/token");
    expect(init.method).toBe("POST");
    const body = init.body.toString();
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=oldR");
  });

  it("失敗応答ならエラーを投げる", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400));
    await expect(refreshAccessToken(CLIENT_ID, "secret", "oldR")).rejects.toThrow(/refresh failed/i);
  });
});
