import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamSync, type TwitchApi } from "../src/streamSync.js";
import { TwitchAuthError, type Stream } from "../src/twitchApi.js";
import type { ChatMonitor } from "../src/chatMonitor.js";
import type { TokenStore } from "../src/tokenStore.js";

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
  const store = { accessToken: "tok", refresh } as unknown as TokenStore;
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

    const sync = new StreamSync("cid", store, monitor, new Set(["foo"]), api);
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

    const sync = new StreamSync("cid", store, monitor, new Set(), api);
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
    };
    const { monitor } = fakeMonitor();
    const { store, refresh } = fakeTokenStore();

    const sync = new StreamSync("cid", store, monitor, new Set(), api);
    await sync.sync(); // 失効 → refresh
    expect(refresh).toHaveBeenCalledTimes(1);

    await sync.sync(); // userId リセット済みなので再度 getCurrentUser
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });
});
