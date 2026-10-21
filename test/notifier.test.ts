import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ConsoleNotifier,
  DiscordNotifier,
  buildReportPayload,
  createNotifier,
  sendDiscordAlert,
  sendDiscordReport,
} from "../src/notifier.js";
import type { FinishedSession } from "../src/timelineRecorder.js";

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
      endReason: "streamEnded",
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
        endReason: "streamEnded",
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
      endReason: "streamEnded",
    });

    const desc = lastPayload().embeds[0].description;
    // 生の [text](url) が埋め込まれていない（[ ] がエスケープされている）
    expect(desc).not.toContain("[無料配布](https://phish.example)");
    expect(desc).toContain("\\[無料配布\\]");
  });

  it("ChatGust 終了による確定は、配信終了と区別した見出しと「記録時間」で送る", async () => {
    await sendDiscordReport(WEBHOOK, {
      channel: "shroud",
      title: "PUBG",
      url: "https://x/reports/1",
      durationMin: 42,
      peakRate: 7,
      endReason: "shutdown",
    });

    const embed = lastPayload().embeds[0];
    expect(embed.title).toContain("shroud");
    expect(embed.title).toContain("途中まで");
    expect(embed.title).not.toContain("配信が終了");
    const durField = embed.fields.find((f: { name: string }) => f.name === "記録時間");
    expect(durField.value).toContain("42");
  });
});

describe("VOD リンク", () => {
  it("アラート embed に VOD リンクがあれば添え、無ければ配信リンクだけにする", async () => {
    const alert = {
      channel: "shroud",
      title: "PUBG",
      rate: 40,
      baseline: 5,
      streamUrl: "https://twitch.tv/shroud",
    };
    await sendDiscordAlert(WEBHOOK, { ...alert, vodUrl: "https://www.twitch.tv/videos/v1?t=0h10m0s" });
    expect(lastPayload().embeds[0].description).toContain(
      "[この場面を VOD で見る](https://www.twitch.tv/videos/v1?t=0h10m0s)"
    );

    fetchMock.mockClear();
    await sendDiscordAlert(WEBHOOK, alert);
    expect(lastPayload().embeds[0].description).not.toContain("VOD");
  });

  it("レポート embed のピーク流速に VOD リンクを添える", async () => {
    await sendDiscordReport(WEBHOOK, {
      channel: "shroud",
      title: "PUBG",
      url: "https://chatgust.fly.dev/reports/abc123",
      durationMin: 83,
      peakRate: 40,
      endReason: "streamEnded",
      peakVodUrl: "https://www.twitch.tv/videos/v1?t=0h10m0s",
    });
    const peakField = lastPayload().embeds[0].fields.find(
      (f: { name: string }) => f.name === "ピーク流速"
    );
    expect(peakField.value).toBe("40 件/30秒（[VOD で見る](https://www.twitch.tv/videos/v1?t=0h10m0s)）");
  });

  it("buildReportPayload はピーク時刻と配信開始から VOD リンクを組み立てる", () => {
    const session: FinishedSession = {
      id: "abc123",
      channel: "shroud",
      title: "PUBG",
      startedAt: 600_000,
      endedAt: 3_600_000,
      peakRate: 40,
      peakAt: 1_230_000, // 配信開始から 20分30秒 → 窓の始まりは 20分00秒
      endReason: "streamEnded",
      stream: { streamId: "s1", startedAt: 0, vodId: "v1" },
    };
    expect(buildReportPayload(session, "https://x").peakVodUrl).toBe(
      "https://www.twitch.tv/videos/v1?t=0h20m0s"
    );
    expect(buildReportPayload({ ...session, stream: null }, "https://x").peakVodUrl).toBeUndefined();
    expect(buildReportPayload({ ...session, peakAt: null }, "https://x").peakVodUrl).toBeUndefined();
  });
});

describe("ConsoleNotifier", () => {
  function logged(): string {
    return vi.mocked(console.log).mock.calls.map((args) => args.join(" ")).join("\n");
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("アラートの内容をコンソールに出し、Discord には送らない", async () => {
    await new ConsoleNotifier().send({
      channel: "foo",
      title: "やばい配信",
      rate: 40,
      baseline: 5,
      streamUrl: "https://twitch.tv/foo",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const out = logged();
    expect(out).toContain("foo");
    expect(out).toContain("やばい配信");
    expect(out).toContain("40");
    expect(out).toContain("8.0倍");
    expect(out).toContain("https://twitch.tv/foo");
    expect(out).not.toContain("VOD");
  });

  it("VOD リンクがあればアラート・レポートとも一緒に出す", async () => {
    const notifier = new ConsoleNotifier();
    await notifier.send({
      channel: "foo",
      title: "t",
      rate: 40,
      baseline: 5,
      streamUrl: "https://twitch.tv/foo",
      vodUrl: "https://www.twitch.tv/videos/v1?t=0h10m0s",
    });
    await notifier.sendReport({
      channel: "foo",
      title: "t",
      url: "https://x/reports/1",
      durationMin: 83,
      peakRate: 40,
      endReason: "streamEnded",
      peakVodUrl: "https://www.twitch.tv/videos/v1?t=0h20m0s",
    });

    const out = logged();
    expect(out).toContain("VOD: https://www.twitch.tv/videos/v1?t=0h10m0s");
    expect(out).toContain("ピークの VOD: https://www.twitch.tv/videos/v1?t=0h20m0s");
  });

  it("振り返りレポートの内容をコンソールに出し、Discord には送らない", async () => {
    await new ConsoleNotifier().sendReport({
      channel: "shroud",
      title: "PUBG ランク",
      url: "https://x/reports/abc123",
      durationMin: 83,
      peakRate: 40,
      endReason: "streamEnded",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const out = logged();
    expect(out).not.toContain("VOD");
    expect(out).toContain("shroud の配信が終了");
    expect(out).toContain("PUBG ランク");
    expect(out).toContain("配信時間 83 分");
    expect(out).toContain("https://x/reports/abc123");
  });

  it("ChatGust 終了による確定は、配信終了と区別した見出しと「記録時間」で出す", async () => {
    await new ConsoleNotifier().sendReport({
      channel: "shroud",
      title: "PUBG",
      url: "https://x/reports/1",
      durationMin: 42,
      peakRate: 7,
      endReason: "shutdown",
    });

    const out = logged();
    expect(out).toContain("途中まで");
    expect(out).not.toContain("配信が終了");
    expect(out).toContain("記録時間 42 分");
  });
});

describe("createNotifier", () => {
  it("Webhook が無ければコンソール出力を選び、その旨をログする", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(createNotifier(undefined)).toBeInstanceOf(ConsoleNotifier);
    expect(logSpy.mock.calls.join("\n")).toContain("コンソールに出力");
  });

  it("Webhook があれば Discord に送る", async () => {
    const notifier = createNotifier(WEBHOOK);
    expect(notifier).toBeInstanceOf(DiscordNotifier);
    await notifier.send({ channel: "foo", title: "t", rate: 10, baseline: 1, streamUrl: "https://twitch.tv/foo" });
    expect(fetchMock.mock.calls[0][0]).toBe(WEBHOOK);
  });
});
