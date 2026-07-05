import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendDiscordAlert, sendDiscordReport } from "../src/notifier.js";

const WEBHOOK = "https://discord.com/api/webhooks/abc/xyz";

function okResponse() {
  return { ok: true, status: 204, text: async () => "" };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastPayload() {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(init.body as string);
}

describe("sendDiscordAlert", () => {
  it("webhook URL へ JSON で POST する", async () => {
    await sendDiscordAlert(WEBHOOK, {
      channel: "foo",
      title: "やばい配信",
      rate: 40,
      baseline: 5,
      streamUrl: "https://twitch.tv/foo",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("embed に channel / title / rate を含む", async () => {
    await sendDiscordAlert(WEBHOOK, {
      channel: "foo",
      title: "やばい配信",
      rate: 40,
      baseline: 5,
      streamUrl: "https://twitch.tv/foo",
    });

    const embed = lastPayload().embeds[0];
    expect(embed.title).toContain("foo");
    expect(embed.description).toContain("やばい配信");
    expect(embed.description).toContain("https://twitch.tv/foo");
    const rateField = embed.fields.find((f: { name: string }) => f.name === "直近30秒");
    expect(rateField.value).toContain("40");
    // 倍率 = 40 / 5 = 8.0
    const multField = embed.fields.find((f: { name: string }) => f.name === "通常の");
    expect(multField.value).toBe("8.0倍");
  });

  it("baseline が 0 のとき倍率は ∞", async () => {
    await sendDiscordAlert(WEBHOOK, {
      channel: "foo",
      title: "t",
      rate: 10,
      baseline: 0,
      streamUrl: "https://twitch.tv/foo",
    });

    const multField = lastPayload().embeds[0].fields.find(
      (f: { name: string }) => f.name === "通常の"
    );
    expect(multField.value).toBe("∞倍");
  });

  it("Discord が非 2xx を返しても throw せず error ログを出す", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendDiscordAlert(WEBHOOK, {
        channel: "foo",
        title: "t",
        rate: 10,
        baseline: 1,
        streamUrl: "https://twitch.tv/foo",
      })
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
  });
});

describe("sendDiscordReport", () => {
  it("振り返りリンク入りの embed を POST する", async () => {
    await sendDiscordReport(WEBHOOK, {
      channel: "shroud",
      title: "PUBG ランク",
      url: "https://chatgust.fly.dev/reports/abc123",
      durationMin: 83,
      peakRate: 40,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");

    const embed = lastPayload().embeds[0];
    expect(embed.title).toContain("shroud");
    expect(embed.description).toContain("PUBG ランク");
    expect(embed.description).toContain("https://chatgust.fly.dev/reports/abc123");
    const durField = embed.fields.find((f: { name: string }) => f.name === "配信時間");
    expect(durField.value).toContain("83");
    const peakField = embed.fields.find((f: { name: string }) => f.name === "ピーク流速");
    expect(peakField.value).toContain("40");
  });

  it("Discord が非 2xx を返しても throw せず error ログを出す", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      sendDiscordReport(WEBHOOK, {
        channel: "foo",
        title: "t",
        url: "https://x/reports/1",
        durationMin: 10,
        peakRate: 5,
      })
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalled();
  });

  it("タイトルの Markdown リンク記法をエスケープしてインジェクションを防ぐ", async () => {
    await sendDiscordReport(WEBHOOK, {
      channel: "foo",
      title: "[無料配布](https://phish.example)",
      url: "https://x/reports/1",
      durationMin: 10,
      peakRate: 5,
    });

    const desc = lastPayload().embeds[0].description;
    // 生の [text](url) が埋め込まれていない（[ ] がエスケープされている）
    expect(desc).not.toContain("[無料配布](https://phish.example)");
    expect(desc).toContain("\\[無料配布\\]");
  });
});
