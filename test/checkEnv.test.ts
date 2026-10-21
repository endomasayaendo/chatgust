import { describe, it, expect } from "vitest";
import { authModeOf, checkOptional, checkRequired } from "../scripts/checkEnv.js";

const example = {
  TWITCH_CLIENT_ID: "your_client_id_here",
  TWITCH_CLIENT_SECRET: "your_client_secret_here",
  DISCORD_WEBHOOK_URL: "",
};

function statuses(env: Record<string, string>) {
  return Object.fromEntries(checkRequired(env, example).map((c) => [c.key, c.status]));
}

describe("checkRequired", () => {
  it("未記入・見本値のまま・記入済みを区別する", () => {
    expect(
      statuses({
        TWITCH_CLIENT_ID: "",
        TWITCH_CLIENT_SECRET: "your_client_secret_here",
      })
    ).toEqual({
      TWITCH_CLIENT_ID: "missing",
      TWITCH_CLIENT_SECRET: "placeholder",
    });
    expect(statuses({ TWITCH_CLIENT_ID: "real-id", TWITCH_CLIENT_SECRET: "real-secret" })).toEqual({
      TWITCH_CLIENT_ID: "ok",
      TWITCH_CLIENT_SECRET: "ok",
    });
  });

  it("キー自体が無い場合も未記入扱い", () => {
    expect(statuses({})).toEqual({
      TWITCH_CLIENT_ID: "missing",
      TWITCH_CLIENT_SECRET: "missing",
    });
  });

  it("各項目に取得場所の案内が付く", () => {
    expect(checkRequired({}, example).every((c) => c.hint.length > 0)).toBe(true);
  });
});

describe("checkOptional", () => {
  function optionalStatus(value: string | undefined) {
    const env: Record<string, string> = value === undefined ? {} : { DISCORD_WEBHOOK_URL: value };
    return checkOptional(env, example).find((c) => c.key === "DISCORD_WEBHOOK_URL")?.status;
  }

  it("DISCORD_WEBHOOK_URL は未記入でもよく、記入済みなら ok", () => {
    expect(optionalStatus(undefined)).toBe("missing");
    expect(optionalStatus("")).toBe("missing");
    expect(optionalStatus("https://discord.com/api/webhooks/123/real")).toBe("ok");
  });

  it("以前の .env.example の見本値のままなら placeholder として拾う", () => {
    expect(optionalStatus("https://discord.com/api/webhooks/xxx/yyy")).toBe("placeholder");
  });

  it("未記入時の代替動作の案内が付く", () => {
    expect(checkOptional({}, example).every((c) => c.unsetNote.length > 0)).toBe(true);
  });
});

describe("authModeOf", () => {
  it("アプリ本体と同じく、アクセストークンの有無で user モードを判定する", () => {
    expect(authModeOf({ TWITCH_ACCESS_TOKEN: "a", TWITCH_REFRESH_TOKEN: "r" })).toBe("user");
    // リフレッシュトークンが空でもアプリは user モードで起動するので、app と案内しない
    expect(authModeOf({ TWITCH_ACCESS_TOKEN: "a", TWITCH_REFRESH_TOKEN: "", NOTIFY_CHANNELS: "foo" })).toBe("user");
  });

  it("トークンが無ければ NOTIFY_CHANNELS の有無で app / 要ログインを分ける", () => {
    expect(authModeOf({ TWITCH_ACCESS_TOKEN: "", NOTIFY_CHANNELS: "foo,bar" })).toBe("app");
    expect(authModeOf({ NOTIFY_CHANNELS: " , " })).toBeUndefined();
    expect(authModeOf({})).toBeUndefined();
  });
});
