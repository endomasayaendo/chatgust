import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamSync, type TwitchApi } from "../src/streamSync.js";
import { TwitchAuthError, type Stream } from "../src/twitchApi.js";
import type { ChatMonitor } from "../src/chatMonitor.js";
import type { AccessTokenSource } from "../src/tokenStore.js";

function fakeMonitor(current: string[] = []) {
  const joined: { channel: string; title: string }[] = [];
  const parted: string[] = [];
  const monitor = {
    getStatus: () => current.map((channel) => ({ channel, title: "", rate: 0, baseline: 0 })),
    join: vi.fn((channel: string, title: string) => joined.push({ channel, title })),
    part: vi.fn((channel: string) => parted.push(channel)),
  } as unknown as ChatMonitor;
  return { monitor, joined, parted };
}

function fakeTokenStore() {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const store: AccessTokenSource = { accessToken: "tok", refresh };
  return { store, refresh };
}

/** app モード用：取得前は空で、refresh で取得する。 */
function fakeAppTokenStore() {
  let token = "";
  const refresh = vi.fn(async () => {
    token = "appTok";
  });
  const store: AccessTokenSource = {
    get accessToken() {
      return token;
    },
    refresh,
  };
  return { store, refresh };
}

function stream(login: string, title = "T"): Stream {
  return { login, title, viewerCount: 0 };
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
    };
    const { monitor, joined } = fakeMonitor();
    const { store } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(["foo"]), "user", api);
    await sync.sync();

    // 許可リストで foo のみが getLiveStreams に渡る
    expect(api.getLiveStreams).toHaveBeenCalledWith("cid", "tok", ["foo"]);
    expect(joined).toEqual([{ channel: "foo", title: "T" }]);
  });

  it("ライブから外れた既存チャンネルは part する", async () => {
    const api: TwitchApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
      getFollowedChannels: vi.fn().mockResolvedValue(["foo", "gone"]),
      getLiveStreams: vi.fn().mockResolvedValue([stream("foo")]),
    };
    const { monitor, parted } = fakeMonitor(["foo", "gone"]); // gone は監視中だが配信終了
    const { store } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), "user", api);
    await sync.sync();

    expect(parted).toEqual(["gone"]);
  });

  it("ユーザー ID は一度取得したら再利用する", async () => {
    const api: TwitchApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: "u1" }),
      getFollowedChannels: vi.fn().mockResolvedValue([]),
      getLiveStreams: vi.fn().mockResolvedValue([]),
    };
    const { monitor } = fakeMonitor();
    const { store } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), "user", api);
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
    };
    const { monitor } = fakeMonitor();
    const { store, refresh } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), "user", api);
    await sync.sync(); // 失効 → refresh
    expect(refresh).toHaveBeenCalledTimes(1);

    await sync.sync(); // userId リセット済みなので再度 getCurrentUser
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });

  describe("app モード（ユーザートークン無し）", () => {
    function appApi(liveLogins: string[]): TwitchApi {
      return {
        getCurrentUser: vi.fn(),
        getFollowedChannels: vi.fn(),
        getLiveStreams: vi.fn(async (_c, _t, logins: string[]) =>
          logins.filter((l) => liveLogins.includes(l)).map((l) => stream(l))
        ),
      };
    }

    it("フォロー一覧を取らず、許可リストのライブ配信を join する", async () => {
      const api = appApi(["foo"]);
      const { monitor, joined } = fakeMonitor();
      const { store } = fakeAppTokenStore();

      const sync = new StreamSync("cid", store, monitor, new Set(["foo", "bar"]), "app", api);
      await sync.sync();

      expect(api.getCurrentUser).not.toHaveBeenCalled();
      expect(api.getFollowedChannels).not.toHaveBeenCalled();
      expect(api.getLiveStreams).toHaveBeenCalledWith("cid", "appTok", ["foo", "bar"]);
      expect(joined).toEqual([{ channel: "foo", title: "T" }]);
    });

    it("トークン未取得なら最初のサイクルで取得し、取得済みなら取り直さない", async () => {
      const api = appApi([]);
      const { monitor } = fakeMonitor();
      const { store, refresh } = fakeAppTokenStore();

      const sync = new StreamSync("cid", store, monitor, new Set(["foo"]), "app", api);
      await sync.sync();
      await sync.sync();

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("401 でトークンを取り直す", async () => {
      const api = appApi([]);
      (api.getLiveStreams as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TwitchAuthError());
      const { monitor } = fakeMonitor();
      const { store, refresh } = fakeAppTokenStore();

      const sync = new StreamSync("cid", store, monitor, new Set(["foo"]), "app", api);
      await sync.sync(); // 初回取得 → 401 → 取り直し

      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("トークン取得に失敗しても throw せず、次のサイクルで再試行する", async () => {
      const api = appApi(["foo"]);
      const { monitor, joined } = fakeMonitor();
      const { store, refresh } = fakeAppTokenStore();
      refresh.mockRejectedValueOnce(new Error("network down"));

      const sync = new StreamSync("cid", store, monitor, new Set(["foo"]), "app", api);
      await expect(sync.sync()).resolves.toBeUndefined();
      expect(joined).toEqual([]);

      await sync.sync();
      expect(joined).toEqual([{ channel: "foo", title: "T" }]);
    });
  });
});
