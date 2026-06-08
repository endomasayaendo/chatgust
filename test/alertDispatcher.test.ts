import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AlertDispatcher } from "../src/alertDispatcher.js";
import type { Notifier, AlertPayload } from "../src/notifier.js";

function fakeNotifier() {
  const sent: AlertPayload[] = [];
  const notifier: Notifier = {
    send: vi.fn(async (p: AlertPayload) => {
      sent.push(p);
    }),
  };
  return { notifier, sent };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AlertDispatcher", () => {
  it("最初の dispatch は通知を送り、payload に streamUrl を組み立てる", () => {
    const { notifier, sent } = fakeNotifier();
    const d = new AlertDispatcher(notifier, 1000, () => 10_000);

    d.dispatch("foo", 40, 5, "やばい配信");

    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({
      channel: "foo",
      title: "やばい配信",
      rate: 40,
      baseline: 5,
      streamUrl: "https://twitch.tv/foo",
    });
  });

  it("クールダウン内の同チャンネルは通知しない", () => {
    const { notifier } = fakeNotifier();
    let now = 10_000;
    const d = new AlertDispatcher(notifier, 1000, () => now);

    d.dispatch("foo", 40, 5, "t");
    now = 10_500; // クールダウン 1000 未満
    d.dispatch("foo", 50, 5, "t");

    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("クールダウン経過後は再び通知する", () => {
    const { notifier } = fakeNotifier();
    let now = 10_000;
    const d = new AlertDispatcher(notifier, 1000, () => now);

    d.dispatch("foo", 40, 5, "t");
    now = 11_000; // クールダウン 1000 ちょうど経過
    d.dispatch("foo", 50, 5, "t");

    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it("別チャンネルはクールダウンを共有しない", () => {
    const { notifier } = fakeNotifier();
    const d = new AlertDispatcher(notifier, 1000, () => 10_000);

    d.dispatch("foo", 40, 5, "t");
    d.dispatch("bar", 40, 5, "t");

    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it("getRecentAlerts は新しい順で limit 件まで返す", () => {
    const { notifier } = fakeNotifier();
    let now = 0;
    const d = new AlertDispatcher(notifier, 0, () => now++);

    d.dispatch("a", 1, 1, "t");
    d.dispatch("b", 2, 1, "t");
    d.dispatch("c", 3, 1, "t");

    const recent = d.getRecentAlerts(2);
    expect(recent.map((r) => r.channel)).toEqual(["c", "b"]);
  });

  it("notifier.send が reject してもエラーを投げず握りつぶす", async () => {
    const notifier: Notifier = { send: vi.fn().mockRejectedValue(new Error("boom")) };
    const d = new AlertDispatcher(notifier, 1000, () => 10_000);

    expect(() => d.dispatch("foo", 40, 5, "t")).not.toThrow();
    await Promise.resolve(); // .catch のマイクロタスクを消化
    expect(console.error).toHaveBeenCalled();
  });
});
