import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { TokenStore } from "../src/tokenStore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "chatgust-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("TokenStore", () => {
  it("refresh で新トークンを取得し accessToken を更新する", async () => {
    const envPath = path.join(dir, ".env");
    writeFileSync(envPath, "TWITCH_ACCESS_TOKEN=old\nTWITCH_REFRESH_TOKEN=oldR\n");
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: "newA", refreshToken: "newR" });

    const store = new TokenStore("cid", "secret", envPath, "old", "oldR", refreshFn);
    await store.refresh();

    expect(refreshFn).toHaveBeenCalledWith("cid", "secret", "oldR");
    expect(store.accessToken).toBe("newA");
  });

  it("既存 .env のトークン行を新しい値で置換して永続化する", async () => {
    const envPath = path.join(dir, ".env");
    writeFileSync(
      envPath,
      "TWITCH_CLIENT_ID=cid\nTWITCH_ACCESS_TOKEN=old\nTWITCH_REFRESH_TOKEN=oldR\n"
    );
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: "newA", refreshToken: "newR" });

    const store = new TokenStore("cid", "secret", envPath, "old", "oldR", refreshFn);
    await store.refresh();

    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("TWITCH_ACCESS_TOKEN=newA");
    expect(content).toContain("TWITCH_REFRESH_TOKEN=newR");
    expect(content).toContain("TWITCH_CLIENT_ID=cid"); // 無関係な行は保持
  });

  it("client secret や refresh token が無ければ throw", async () => {
    const store = new TokenStore("cid", "", path.join(dir, ".env"), "old", "oldR", vi.fn());
    await expect(store.refresh()).rejects.toThrow(/Cannot refresh/);
  });

  it(".env が存在しなくても throw せず（永続化のみスキップ）トークンは更新される", async () => {
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: "newA", refreshToken: "newR" });
    const store = new TokenStore(
      "cid",
      "secret",
      path.join(dir, "missing.env"),
      "old",
      "oldR",
      refreshFn
    );

    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.accessToken).toBe("newA");
  });
});
