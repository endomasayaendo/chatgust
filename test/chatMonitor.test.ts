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
