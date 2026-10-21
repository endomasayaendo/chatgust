import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamSync, type TwitchApi } from "../src/streamSync.js";
import { TwitchAuthError, type Stream } from "../src/twitchApi.js";
import type { ChatMonitor } from "../src/chatMonitor.js";
import type { TokenStore } from "../src/tokenStore.js";
import type { StreamRef } from "../src/vod.js";

function fakeMonitor(current: string[] = []) {
  const joined: { channel: string; title: string; stream?: StreamRef }[] = [];
  const parted: string[] = [];
  const monitor = {
    getStatus: () => current.map((channel) => ({ channel, title: "", rate: 0, baseline: 0 })),
    join: vi.fn((channel: string, title: string, stream?: StreamRef) =>
      joined.push({ channel, title, stream })
    ),
    part: vi.fn((channel: string) => parted.push(channel)),
  } as unknown as ChatMonitor;
  return { monitor, joined, parted };
}

function fakeTokenStore() {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const store = { accessToken: "tok", refresh } as unknown as TokenStore;
  return { store, refresh };
}

function stream(login: string, title = "T"): Stream {
  return { login, title, viewerCount: 0, userId: `id-${login}`, streamId: `s-${login}`, startedAt: 1000 };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StreamSync", () => {
  it("ライブ配信を monitor に join し、許可リストで絞り込む", async () => {
    const api: TwitchApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
      getFollowedChannels: vi.fn().mockResolvedValue(["foo", "bar", "baz"]),
      getLiveStreams: vi.fn(async (_c, _t, logins: string[]) =>
        logins.filter((l) => l === "foo").map((l) => stream(l))
      ),
      getArchiveVideoId: vi.fn().mockResolvedValue(null),
    };
    const { monitor, joined } = fakeMonitor();
    const { store } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(["foo"]), api);
    await sync.sync();

    // 許可リストで foo のみが getLiveStreams に渡る
    expect(api.getLiveStreams).toHaveBeenCalledWith("cid", "tok", ["foo"]);
    expect(joined).toEqual([
      { channel: "foo", title: "T", stream: { streamId: "s-foo", startedAt: 1000, vodId: null } },
    ]);
  });

  it("ライブから外れた既存チャンネルは part する", async () => {
    const api: TwitchApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
      getFollowedChannels: vi.fn().mockResolvedValue(["foo", "gone"]),
      getLiveStreams: vi.fn().mockResolvedValue([stream("foo")]),
      getArchiveVideoId: vi.fn().mockResolvedValue(null),
    };
    const { monitor, parted } = fakeMonitor(["foo", "gone"]); // gone は監視中だが配信終了
    const { store } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), api);
    await sync.sync();

    expect(parted).toEqual(["gone"]);
  });

  it("ユーザー ID は一度取得したら再利用する", async () => {
    const api: TwitchApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
      getFollowedChannels: vi.fn().mockResolvedValue([]),
      getLiveStreams: vi.fn().mockResolvedValue([]),
      getArchiveVideoId: vi.fn().mockResolvedValue(null),
    };
    const { monitor } = fakeMonitor();
    const { store } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), api);
    await sync.sync();
    await sync.sync();

    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("401（TwitchAuthError）で tokenStore.refresh を呼び、userId を取り直す", async () => {
    const getCurrentUser = vi
      .fn()
      .mockRejectedValueOnce(new TwitchAuthError()) // 1回目: 失効
      .mockResolvedValue({ id: "u2" }); // 2回目: 再取得
    const api: TwitchApi = {
      getCurrentUser,
      getFollowedChannels: vi.fn().mockResolvedValue([]),
      getLiveStreams: vi.fn().mockResolvedValue([]),
      getArchiveVideoId: vi.fn().mockResolvedValue(null),
    };
    const { monitor } = fakeMonitor();
    const { store, refresh } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), api);
    await sync.sync(); // 失効 → refresh
    expect(refresh).toHaveBeenCalledTimes(1);

    await sync.sync(); // userId リセット済みなので再度 getCurrentUser
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });

  describe("VOD の解決", () => {
    function apiWithVod(getArchiveVideoId: TwitchApi["getArchiveVideoId"]): TwitchApi {
      return {
        getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
        getFollowedChannels: vi.fn().mockResolvedValue(["foo"]),
        getLiveStreams: vi.fn().mockResolvedValue([stream("foo")]),
        getArchiveVideoId,
      };
    }

    it("見つかった VOD を join に添え、以降の同期では引き直さない", async () => {
      const getVod = vi.fn().mockResolvedValue("v1");
      const { monitor, joined } = fakeMonitor();
      const sync = new StreamSync("cid", fakeTokenStore().store, monitor, new Set(), apiWithVod(getVod));

      await sync.sync();
      await sync.sync();

      expect(getVod).toHaveBeenCalledTimes(1);
      expect(getVod).toHaveBeenCalledWith("cid", "tok", "id-foo", "s-foo");
      // 1回目: VOD を待たずに join → 見つかった VOD を付けて join し直す。2回目: キャッシュ済み
      expect(joined.map((j) => j.stream?.vodId)).toEqual([null, "v1", "v1"]);
    });

    it("VOD の応答を待たずに join する（監視開始を遅らせない）", async () => {
      let answer: (vodId: string | null) => void = () => {};
      const getVod = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
      const { monitor, joined } = fakeMonitor();
      const sync = new StreamSync("cid", fakeTokenStore().store, monitor, new Set(), apiWithVod(getVod));

      const pending = sync.sync();
      await vi.waitFor(() => expect(getVod).toHaveBeenCalled());
      expect(joined.map((j) => j.channel)).toEqual(["foo"]); // VOD 未応答の時点で join 済み

      answer("v1");
      await pending;
      expect(joined.map((j) => j.stream?.vodId)).toEqual([null, "v1"]);
    });

    it("見つからなければ vodId=null で join し、次の同期で引き直す", async () => {
      const getVod = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("v1");
      const { monitor, joined } = fakeMonitor();
      const sync = new StreamSync("cid", fakeTokenStore().store, monitor, new Set(), apiWithVod(getVod));

      await sync.sync();
      await sync.sync();

      expect(joined.map((j) => j.stream?.vodId)).toEqual([null, null, "v1"]);
    });

    it("VOD の取得に失敗しても join は行う（VOD なし）", async () => {
      const getVod = vi.fn().mockRejectedValue(new Error("Twitch API 500"));
      const { monitor, joined } = fakeMonitor();
      const sync = new StreamSync("cid", fakeTokenStore().store, monitor, new Set(), apiWithVod(getVod));

      await sync.sync();

      expect(joined).toEqual([
        { channel: "foo", title: "T", stream: { streamId: "s-foo", startedAt: 1000, vodId: null } },
      ]);
    });
  });
});
