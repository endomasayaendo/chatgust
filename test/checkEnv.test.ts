import { describe, it, expect } from "vitest";
import { checkRequired, hasNotifyChannels, hasTokens } from "../scripts/checkEnv.js";

const example = {
  TWITCH_CLIENT_ID: "your_client_id_here",
  TWITCH_CLIENT_SECRET: "your_client_secret_here",
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/xxx/yyy",
};

function statuses(env: Record<string, string>) {
  return Object.fromEntries(checkRequired(env, example).map((c) => [c.key, c.status]));
}

describe("checkRequired", () => {
  it("未記入・見本値のまま・記入済みを区別する", () => {
    expect(
      statuses({
        TWITCH_CLIENT_ID: "",
        TWITCH_CLIENT_SECRET: "real-secret",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/xxx/yyy",
      })
    ).toEqual({
      TWITCH_CLIENT_ID: "missing",
      TWITCH_CLIENT_SECRET: "ok",
      DISCORD_WEBHOOK_URL: "placeholder",
    });
  });

  it("キー自体が無い場合も未記入扱い", () => {
    expect(statuses({})).toEqual({
      TWITCH_CLIENT_ID: "missing",
      TWITCH_CLIENT_SECRET: "missing",
      DISCORD_WEBHOOK_URL: "missing",
    });
  });

  it("各項目に取得場所の案内が付く", () => {
    expect(checkRequired({}, example).every((c) => c.hint.length > 0)).toBe(true);
  });
});

describe("hasTokens", () => {
  it("アクセストークンとリフレッシュトークンが両方あるときだけ true", () => {
    expect(hasTokens({ TWITCH_ACCESS_TOKEN: "a", TWITCH_REFRESH_TOKEN: "r" })).toBe(true);
    expect(hasTokens({ TWITCH_ACCESS_TOKEN: "a", TWITCH_REFRESH_TOKEN: "" })).toBe(false);
    expect(hasTokens({})).toBe(false);
  });
});

describe("hasNotifyChannels", () => {
  it("NOTIFY_CHANNELS に1つ以上のチャンネルがあるときだけ true", () => {
    expect(hasNotifyChannels({ NOTIFY_CHANNELS: "foo,bar" })).toBe(true);
    expect(hasNotifyChannels({ NOTIFY_CHANNELS: " , " })).toBe(false);
    expect(hasNotifyChannels({ NOTIFY_CHANNELS: "" })).toBe(false);
    expect(hasNotifyChannels({})).toBe(false);
  });
});
