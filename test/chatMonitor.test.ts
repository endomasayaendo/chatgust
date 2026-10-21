import { describe, it, expect, vi, afterEach } from "vitest";
import { ChatMonitor, type SessionObserver } from "../src/chatMonitor.js";
import type { IrcClient } from "../src/ircClient.js";
import type { SpikeDetector } from "../src/rateDetector.js";

const cfg = { spikeThreshold: 8, minRate: 5, spikeZ: 3 };

function setup() {
  const irc = { join: vi.fn(), part: vi.fn(), destroy: vi.fn() };
  const observer: SessionObserver = {
    onJoin: vi.fn(),
    onSample: vi.fn(),
    onTitleChange: vi.fn(),
    onVodFound: vi.fn(),
    onPart: vi.fn(),
  };
  const detector: SpikeDetector = {
    addMessage() {},
    getRate: () => 1,
    getBaseline: () => 0,
    isSpike: () => false,
  };
  const monitor = new ChatMonitor(() => {}, cfg, {
    irc: irc as unknown as IrcClient,
    detectorFactory: () => detector,
    observer,
  });
  return { monitor, irc, observer };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatMonitor.destroy", () => {
  it("破棄後の join は無視し、IRC 接続・セッション開始・検知ループを復活させない", () => {
    vi.useFakeTimers();
    const { monitor, irc, observer } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});

    monitor.destroy();
    monitor.join("late", "終了処理中に完了した同期");
    vi.advanceTimersByTime(10_000);

    expect(irc.join).not.toHaveBeenCalled();
    expect(observer.onJoin).not.toHaveBeenCalled();
    expect(observer.onSample).not.toHaveBeenCalled();
    expect(monitor.getStatus()).toEqual([]);
  });
});

describe("ChatMonitor の配信情報（VOD）", () => {
  const stream = { streamId: "s1", startedAt: 0, vodId: null };

  it("join 後に同じ配信の VOD が見つかったら onVodFound を1回だけ呼ぶ", () => {
    const { monitor, observer } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});

    monitor.join("a", "T", stream);
    expect(observer.onJoin).toHaveBeenCalledWith("a", "T", stream);

    monitor.join("a", "T", { ...stream, vodId: "v1" });
    monitor.join("a", "T", { ...stream, vodId: "v1" }); // 変化なし
    expect(observer.onVodFound).toHaveBeenCalledTimes(1);
    expect(observer.onVodFound).toHaveBeenCalledWith("a", "v1");
  });

  it("別の配信（streamId 違い）の VOD は今のセッションに付けない", () => {
    const { monitor, observer } = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});

    monitor.join("a", "T", stream);
    monitor.join("a", "T", { streamId: "s2", startedAt: 1, vodId: "v2" });

    expect(observer.onVodFound).not.toHaveBeenCalled();
  });

  it("アラートに配信情報（見つかった VOD 込み）を渡す", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const onAlert = vi.fn();
    const spiking: SpikeDetector = {
      addMessage() {},
      getRate: () => 50,
      getBaseline: () => 5,
      isSpike: () => true,
    };
    const monitor = new ChatMonitor(onAlert, cfg, {
      irc: { join() {}, part() {}, destroy() {} } as unknown as IrcClient,
      detectorFactory: () => spiking,
      policy: { confirm: () => true, forget() {} },
    });

    monitor.join("a", "T", stream);
    monitor.join("a", "T", { ...stream, vodId: "v1" });
    vi.advanceTimersByTime(5_000);
    monitor.destroy();

    expect(onAlert).toHaveBeenCalledWith("a", 50, 5, "T", { ...stream, vodId: "v1" });
  });
});
