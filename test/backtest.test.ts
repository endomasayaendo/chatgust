import { describe, it, expect, vi, afterEach } from "vitest";
import { parseParams, reconstructWindowCounts, replaySession, type BacktestParams } from "../scripts/backtest.js";
import { ChatMonitor } from "../src/chatMonitor.js";
import { AlertDispatcher } from "../src/alertDispatcher.js";
import { RateDetector, judgeSpike } from "../src/rateDetector.js";
import type { IrcClient } from "../src/ircClient.js";
import type { Sample } from "../src/timelineRepository.js";

const PARAMS: BacktestParams = { z: 3, threshold: 8, minRate: 5, cooldownMin: 5 };

/** 0〜(n-1)×5秒 の等間隔サンプル。rateAt(t) で各時点の件数を決める。 */
function samples(n: number, rateAt: (t: number) => number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({ t: (i + 1) * 5000, rate: rateAt((i + 1) * 5000) }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("judgeSpike", () => {
  const flat = Array(10).fill(10);
  const noisy = [8, 12, 9, 11, 10, 10, 9, 11, 12, 8];

  it("minRate 未満は false", () => {
    expect(judgeSpike(4, Array(10).fill(0), PARAMS)).toBe(false);
  });

  it("ベースライン < 1 のときは minRate*2 を閾値にする", () => {
    expect(judgeSpike(9, Array(10).fill(0), PARAMS)).toBe(false);
    expect(judgeSpike(10, Array(10).fill(0), PARAMS)).toBe(true);
  });

  it("z スコア（平均 + z×σ）以上で true", () => {
    // 平均 10、σ ≈ 1.34 → 10 + 3σ ≈ 14.0
    expect(judgeSpike(15, noisy, PARAMS)).toBe(true);
    expect(judgeSpike(13, noisy, PARAMS)).toBe(false);
  });

  it("ばらつきが無いときは乗算ルール（baseline×threshold）にフォールバック", () => {
    expect(judgeSpike(79, flat, PARAMS)).toBe(false);
    expect(judgeSpike(80, flat, PARAMS)).toBe(true);
  });
});

describe("reconstructWindowCounts", () => {
  it("k 窓前の件数として k×30秒前のサンプルを使い、開始前は 0", () => {
    const s = samples(60, (t) => t / 5000); // t=5000k の rate は k
    // t=150000 → 120000, 90000, 60000, 30000 の rate = 24, 18, 12, 6、それ以前は開始前
    expect(reconstructWindowCounts(s, 150_000)).toEqual([24, 18, 12, 6, 0, 0, 0, 0, 0, 0]);
  });

  it("時刻ずれ・記録の欠けがあっても 0 件にはせず、最も近いサンプルで埋める", () => {
    const s: Sample[] = [
      { t: 28_000, rate: 7 }, // 30000 に最も近い
      { t: 52_000, rate: 9 }, // 60000 の 8 秒前（間が欠けている）
      { t: 90_000, rate: 1 },
    ];
    expect(reconstructWindowCounts(s, 90_000).slice(0, 3)).toEqual([9, 7, 0]);
  });
});

describe("replaySession", () => {
  const startedAt = Date.UTC(2026, 9, 20, 12, 0, 0);
  const burst = (from: number, to: number) => (t: number) => (t >= from && t < to ? 60 : 3);

  it("スパイクが2回連続したときに通知し、ウォームアップ中は通知しない", () => {
    const s = { channel: "foo", startedAt, samples: samples(60, burst(60_000, 70_000)) };
    expect(replaySession(s, PARAMS)).toEqual([]); // 2分以内の山は無視

    const later = { channel: "foo", startedAt, samples: samples(60, burst(200_000, 210_000)) };
    const alerts = replaySession(later, PARAMS);
    expect(alerts.map((a) => a.at)).toEqual([startedAt + 205_000]); // 200000 で1回目、205000 で確定
    expect(alerts[0].rate).toBe(60);
  });

  it("クールダウン中の連続スパイクは1回にまとめる", () => {
    const rateAt = (t: number) => (t >= 200_000 && t < 210_000) || (t >= 300_000 && t < 310_000) ? 60 : 3;
    const s = { channel: "foo", startedAt, samples: samples(120, rateAt) };
    expect(replaySession(s, PARAMS)).toHaveLength(1);
    expect(replaySession(s, { ...PARAMS, cooldownMin: 1 })).toHaveLength(2);
  });
});

describe("parseParams", () => {
  it("指定したキーだけ上書きし、残りは base を使う", () => {
    expect(parseParams("z=2.5, cooldown=10", PARAMS)).toEqual({ ...PARAMS, z: 2.5, cooldownMin: 10 });
  });

  it("未知のキー・不正な値は throw", () => {
    expect(() => parseParams("foo=1", PARAMS)).toThrow(/Invalid --params/);
    expect(() => parseParams("z=0", PARAMS)).toThrow(/Invalid --params/);
  });
});

describe("本番パイプラインとの一致", () => {
  // 再現可能な疑似乱数（mulberry32）
  function rng(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([1, 2, 3])(
    "本番の ChatMonitor が記録した流速を再生すると、本番と同じ時刻に通知が出る (seed=%i)",
    (seed) => {
      const rand = rng(seed);
      const startedAt = Date.UTC(2026, 9, 20, 12, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(startedAt);
      vi.spyOn(console, "log").mockImplementation(() => {});

      // --- 本番の検知〜クールダウンをそのまま動かし、記録（サンプル）と通知時刻を取る ---
      const recorded: Sample[] = [];
      const fired: number[] = [];
      const dispatcher = new AlertDispatcher({ send: async () => {} }, PARAMS.cooldownMin * 60_000);
      let detector!: RateDetector;
      const monitor = new ChatMonitor(
        (channel, rate, baseline, title) => {
          const before = dispatcher.getRecentAlerts().length;
          dispatcher.dispatch(channel, rate, baseline, title);
          if (dispatcher.getRecentAlerts().length > before) fired.push(Date.now());
        },
        { spikeThreshold: PARAMS.threshold, minRate: PARAMS.minRate, spikeZ: PARAMS.z },
        {
          irc: { join() {}, part() {}, destroy() {} } as unknown as IrcClient,
          detectorFactory: () => (detector = new RateDetector()),
          observer: {
            onJoin() {},
            onSample: (_ch, rate) => recorded.push({ t: Date.now() - startedAt, rate }),
            onTitleChange() {},
            onPart() {},
          },
        }
      );
      monitor.join("foo", "テスト配信");

      // 40分ぶんの受信。平常は毎秒 0〜4 件、ランダムな時刻に 20〜60 秒の盛り上がり（毎秒 4〜12 件）。
      // 受信時刻は ms 単位でずらし、5秒タイマー・窓境界ちょうどには置かない（境界の扱いの差は対象外）。
      const bursts = Array.from({ length: 6 }, () => ({
        from: 150 + Math.floor(rand() * 2200),
        len: 20 + Math.floor(rand() * 40),
        rate: 4 + Math.floor(rand() * 9),
      }));
      for (let sec = 0; sec < 40 * 60; sec++) {
        const burst = bursts.find((b) => sec >= b.from && sec < b.from + b.len);
        const n = burst ? burst.rate : Math.floor(rand() * 5);
        const offsets = Array.from({ length: n }, () => 1 + Math.floor(rand() * 998)).sort((a, b) => a - b);
        for (const off of offsets) {
          vi.advanceTimersByTime(startedAt + sec * 1000 + off - Date.now());
          detector.addMessage();
        }
      }
      vi.advanceTimersByTime(startedAt + 40 * 60_000 - Date.now());
      monitor.destroy();

      // --- 記録だけからバックテストで再生 ---
      const replayed = replaySession({ channel: "foo", startedAt, samples: recorded }, PARAMS);

      expect(fired.length).toBeGreaterThan(0);
      expect(replayed.map((a) => a.at)).toEqual(fired);
    }
  );
});
