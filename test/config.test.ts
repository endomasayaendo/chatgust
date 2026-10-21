import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  TWITCH_CLIENT_ID: "cid",
  TWITCH_ACCESS_TOKEN: "tok",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/x",
};

describe("loadConfig", () => {
  it("必須 env（CLIENT_ID）が欠けると throw", () => {
    expect(() => loadConfig({ ...base, TWITCH_CLIENT_ID: undefined })).toThrow(/Missing required/);
  });

  it("DISCORD_WEBHOOK_URL は任意（未設定・空文字なら undefined）", () => {
    expect(loadConfig({ ...base, DISCORD_WEBHOOK_URL: undefined }).discordWebhookUrl).toBeUndefined();
    expect(loadConfig({ ...base, DISCORD_WEBHOOK_URL: "" }).discordWebhookUrl).toBeUndefined();
    expect(loadConfig(base).discordWebhookUrl).toBe("https://discord.com/api/webhooks/x");
  });

  it("以前の .env.example の見本値のままの DISCORD_WEBHOOK_URL は未設定扱い", () => {
    const cfg = loadConfig({ ...base, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/xxx/yyy" });
    expect(cfg.discordWebhookUrl).toBeUndefined();
  });

  it("REQUIRE_DISCORD_WEBHOOK があれば（本番）DISCORD_WEBHOOK_URL 未設定で throw", () => {
    expect(() =>
      loadConfig({ ...base, REQUIRE_DISCORD_WEBHOOK: "1", DISCORD_WEBHOOK_URL: "" })
    ).toThrow(/DISCORD_WEBHOOK_URL is required/);
    expect(loadConfig({ ...base, REQUIRE_DISCORD_WEBHOOK: "1" }).discordWebhookUrl).toBe(
      "https://discord.com/api/webhooks/x"
    );
  });

  it("ユーザートークンがあれば user モード（NOTIFY_CHANNELS の有無によらない）", () => {
    expect(loadConfig(base).authMode).toBe("user");
    expect(loadConfig({ ...base, NOTIFY_CHANNELS: "foo" }).authMode).toBe("user");
  });

  it("ユーザートークンが無く NOTIFY_CHANNELS があれば app モード（ログイン不要）", () => {
    const cfg = loadConfig({
      ...base,
      TWITCH_ACCESS_TOKEN: undefined,
      TWITCH_CLIENT_SECRET: "secret",
      NOTIFY_CHANNELS: "foo",
    });
    expect(cfg.authMode).toBe("app");
    expect(cfg.accessToken).toBe("");
  });

  it("ユーザートークンも NOTIFY_CHANNELS も無ければ make auth を案内して throw", () => {
    expect(() => loadConfig({ ...base, TWITCH_ACCESS_TOKEN: undefined })).toThrow(/make auth/);
    // 空文字（.env の `TWITCH_ACCESS_TOKEN=`）も未設定扱い
    expect(() => loadConfig({ ...base, TWITCH_ACCESS_TOKEN: "", NOTIFY_CHANNELS: " , " })).toThrow(/make auth/);
  });

  it("app モードで TWITCH_CLIENT_SECRET が無ければ throw", () => {
    expect(() =>
      loadConfig({ ...base, TWITCH_ACCESS_TOKEN: "", NOTIFY_CHANNELS: "foo" })
    ).toThrow(/TWITCH_CLIENT_SECRET/);
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

  it("空文字の DATA_DIR / PUBLIC_BASE_URL は既定にフォールバックする（.env の空値対策）", () => {
    const cfg = loadConfig({ ...base, DATA_DIR: "", PUBLIC_BASE_URL: "" });
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.publicBaseUrl).toBe("http://localhost:3000");
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
