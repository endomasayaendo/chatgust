import { describe, it, expect } from "vitest";
import { vodLinkForWindow, vodTimestampUrl } from "../src/vod.js";

describe("vodTimestampUrl", () => {
  it("オフセットを 1h02m03s 形式で付ける", () => {
    expect(vodTimestampUrl("123", 3_723_000)).toBe("https://www.twitch.tv/videos/123?t=1h02m03s");
  });

  it("負のオフセットは 0 に丸める（配信開始直後の盛り上がり）", () => {
    expect(vodTimestampUrl("123", -5_000)).toBe("https://www.twitch.tv/videos/123?t=0h00m00s");
  });
});

describe("vodLinkForWindow", () => {
  const stream = { streamId: "s1", startedAt: 1_000_000, vodId: "v1" };

  it("集計窓（30秒）の始まり＝窓の終わりの30秒前を、配信開始からのオフセットで指す", () => {
    // 配信開始から 10分30秒 で終わる窓 → 10分00秒 を指す
    expect(vodLinkForWindow(stream, 1_000_000 + 630_000)).toBe(
      "https://www.twitch.tv/videos/v1?t=0h10m00s"
    );
  });

  it("VOD が無い・配信情報が無いなら undefined", () => {
    expect(vodLinkForWindow({ ...stream, vodId: null }, 2_000_000)).toBeUndefined();
    expect(vodLinkForWindow(null, 2_000_000)).toBeUndefined();
    expect(vodLinkForWindow(undefined, 2_000_000)).toBeUndefined();
  });
});
