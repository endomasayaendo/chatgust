import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  TWITCH_CLIENT_ID: "cid",
  TWITCH_ACCESS_TOKEN: "tok",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x",
};

describe("loadConfig", () => {
  it("必須 env（CLIENT_ID/ACCESS_TOKEN/WEBHOOK）が欠けると throw", () => {
    expect(() => loadConfig({ ...base, TWITCH_CLIENT_ID: undefined })).toThrow(/Missing required/);
    expect(() => loadConfig({ ...base, TWITCH_ACCESS_TOKEN: undefined })).toThrow(/Missing required/);
    expect(() => loadConfig({ ...base, DISCORD_WEBHOOK_URL: undefined })).toThrow(/Missing required/);
  });

  it("不正な数値（0・非数）は throw する", () => {
    expect(() => loadConfig({ ...base, SPIKE_Z: "0" })).toThrow(/SPIKE_Z/);
    expect(() => loadConfig({ ...base, MIN_RATE: "abc" })).toThrow(/MIN_RATE/);
    expect(() => loadConfig({ ...base, COOLDOWN_MIN: "-1" })).toThrow(/COOLDOWN_MIN/);
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: "0" })).toThrow(/PORT/);
  });

  it("デフォルト値を適用する", () => {
    const cfg = loadConfig(base);
    expect(cfg.spikeThreshold).toBe(8);
    expect(cfg.spikeZ).toBe(3.0);
    expect(cfg.minRate).toBe(5);
    expect(cfg.cooldownMin).toBe(5);
    expect(cfg.port).toBe(3000);
    expect(cfg.notifyChannels.size).toBe(0);
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.publicBaseUrl).toBe("http://localhost:3000");
  });

  it("DATA_DIR / PUBLIC_BASE_URL を上書きできる", () => {
    const cfg = loadConfig({ ...base, DATA_DIR: "/data", PUBLIC_BASE_URL: "https://chatgust.fly.dev" });
    expect(cfg.dataDir).toBe("/data");
    expect(cfg.publicBaseUrl).toBe("https://chatgust.fly.dev");
  });

  it("NOTIFY_CHANNELS を許可リスト集合へパースする", () => {
    const cfg = loadConfig({ ...base, NOTIFY_CHANNELS: "Foo, BAR" });
    expect([...cfg.notifyChannels]).toEqual(["foo", "bar"]);
  });

  it("指定した値を型付きで返す", () => {
    const cfg = loadConfig({
      ...base,
      TWITCH_CLIENT_SECRET: "secret",
      TWITCH_REFRESH_TOKEN: "rtok",
      DASHBOARD_PASSWORD: "pw",
      SPIKE_Z: "3.5",
    });
    expect(cfg.twitchClientId).toBe("cid");
    expect(cfg.twitchClientSecret).toBe("secret");
    expect(cfg.accessToken).toBe("tok");
    expect(cfg.refreshToken).toBe("rtok");
    expect(cfg.dashboardPassword).toBe("pw");
    expect(cfg.spikeZ).toBe(3.5);
  });
});
