import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateDetector } from "../src/rateDetector.js";

// 内部定数（src/rateDetector.ts と一致）
const WINDOW = 30_000; // 30秒ウィンドウ
const WARMUP = 2 * 60_000; // 2分のウォームアップ
const MAX_HISTORY = 11 * WINDOW; // 330秒

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getRate", () => {
  it("直近30秒以内のメッセージだけを数える", () => {
    const d = new RateDetector();
    d.addMessage();
    d.addMessage();
    expect(d.getRate()).toBe(2);

    // 31秒進めると両方ウィンドウ外になる
    vi.setSystemTime(31_000);
    expect(d.getRate()).toBe(0);
  });

  it("ウィンドウをまたいで新旧が混ざっても新しい分だけ数える", () => {
    const d = new RateDetector();
    d.addMessage(); // t=0（古い）

    vi.setSystemTime(20_000);
    d.addMessage(); // t=20000（新しい）

    vi.setSystemTime(35_000); // cutoff=5000 → t=0 は外、t=20000 は内
    expect(d.getRate()).toBe(1);
  });
});

describe("getBaseline", () => {
  it("直前10ウィンドウの平均を返す", () => {
    const d = new RateDetector();
    // 10ウィンドウ（[0,30000) 〜 [270000,300000)）の各中心に2件ずつ配置 = 計20件
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * WINDOW + WINDOW / 2);
      d.addMessage();
      d.addMessage();
    }
    // now=330000 で評価すると上記10ウィンドウがちょうどベースライン対象
    vi.setSystemTime(MAX_HISTORY);
    expect(d.getBaseline()).toBeCloseTo(2); // 20 / 10
  });

  it("過去にメッセージが無ければ0", () => {
    const d = new RateDetector();
    vi.setSystemTime(MAX_HISTORY);
    expect(d.getBaseline()).toBe(0);
  });
});

describe("addMessage（履歴の枝刈り）", () => {
  it("MAX_HISTORY を超えた古いメッセージはレート・ベースラインに反映されない", () => {
    const d = new RateDetector();
    d.addMessage(); // t=0

    // 履歴上限を超えて十分に時間を進めてから新規追加（古い分が枝刈りされる）
    vi.setSystemTime(MAX_HISTORY + 10_000);
    d.addMessage();

    // t=0 の分は消えており、最新の1件だけが直近レートに残る
    expect(d.getRate()).toBe(1);
    expect(d.getBaseline()).toBe(0);
  });
});

describe("isSpike", () => {
  it("ウォームアップ中（2分以内）は常に false", () => {
    const d = new RateDetector();
    vi.setSystemTime(60_000); // 60秒 < ウォームアップ120秒
    for (let i = 0; i < 20; i++) d.addMessage();
    expect(d.isSpike(8, 5, 2.5)).toBe(false);
  });

  it("レートが minRate 未満なら false", () => {
    const d = new RateDetector();
    vi.setSystemTime(WARMUP + 10_000); // ウォームアップ済み
    for (let i = 0; i < 3; i++) d.addMessage(); // rate=3
    expect(d.isSpike(8, 5, 2.5)).toBe(false);
  });

  it("baseline < 1 のときは minRate*2 を閾値に使う", () => {
    const d = new RateDetector();
    vi.setSystemTime(WARMUP + 10_000); // 過去ウィンドウは空 → baseline=0

    for (let i = 0; i < 9; i++) d.addMessage(); // rate=9 < minRate*2=10
    expect(d.isSpike(8, 5, 2.5)).toBe(false);

    d.addMessage(); // rate=10 >= 10
    expect(d.isSpike(8, 5, 2.5)).toBe(true);
  });

  it("ウォームアップ後、rate >= baseline*threshold で true", () => {
    const d = new RateDetector();
    // baseline=2 を作る（10ウィンドウに2件ずつ）
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * WINDOW + WINDOW / 2);
      d.addMessage();
      d.addMessage();
    }
    // now=330000（ウォームアップ済み）でバースト。直近30秒の件数だけが rate。
    vi.setSystemTime(MAX_HISTORY);
    for (let i = 0; i < 16; i++) d.addMessage(); // rate=16

    // baseline=2, threshold=8 → 閾値16。16 >= 16 で true
    expect(d.getBaseline()).toBeCloseTo(2);
    expect(d.isSpike(8, 5, 2.5)).toBe(true);
  });

  it("ウォームアップ後でも baseline*threshold 未満なら false", () => {
    const d = new RateDetector();
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * WINDOW + WINDOW / 2);
      d.addMessage();
      d.addMessage();
    }
    vi.setSystemTime(MAX_HISTORY);
    for (let i = 0; i < 15; i++) d.addMessage(); // rate=15 < 16
    expect(d.isSpike(8, 5, 2.5)).toBe(false);
  });

  // ベースラインの各ウィンドウに任意の件数を仕込むヘルパー（counts[0] が最も古いウィンドウ）
  function seedWindows(d: RateDetector, counts: number[]): void {
    for (let w = 0; w < counts.length; w++) {
      const center = w * WINDOW + WINDOW / 2; // [0,30000) 〜 が最も古い
      vi.setSystemTime(center);
      for (let n = 0; n < counts[w]; n++) d.addMessage();
    }
  }

  it("大手チャット（高ベースライン）でも z スコアでスパイクを検知する", () => {
    const d = new RateDetector();
    // 平均100, 標準偏差10 のベースラインを作る（90×5, 110×5）
    seedWindows(d, [90, 90, 90, 90, 90, 110, 110, 110, 110, 110]);

    vi.setSystemTime(MAX_HISTORY);
    for (let i = 0; i < 130; i++) d.addMessage(); // rate=130

    // 乗算ルールでは 100*8=800 が必要で鳴らないが、
    // z=2.5 の閾値 100 + 2.5*10 = 125 を超えるので検知できる
    expect(d.getBaseline()).toBeCloseTo(100);
    expect(d.isSpike(8, 5, 2.5)).toBe(true);
  });

  it("高ベースラインでも z 閾値未満なら鳴らない", () => {
    const d = new RateDetector();
    seedWindows(d, [90, 90, 90, 90, 90, 110, 110, 110, 110, 110]); // 平均100, σ10

    vi.setSystemTime(MAX_HISTORY);
    for (let i = 0; i < 120; i++) d.addMessage(); // rate=120 < 125（=100+2.5σ）

    expect(d.isSpike(8, 5, 2.5)).toBe(false);
  });
});

// 旧実装（受信のたびに全件 filter）。データ構造変更後も判定が同一であることの基準にする。
class NaiveRateDetector {
  private timestamps: number[] = [];
  private readonly startedAt = Date.now();

  addMessage(): void {
    const now = Date.now();
    this.timestamps.push(now);
    this.timestamps = this.timestamps.filter((t) => t > now - MAX_HISTORY);
  }

  getRate(): number {
    const cutoff = Date.now() - WINDOW;
    return this.timestamps.filter((t) => t > cutoff).length;
  }

  private getWindowCounts(): number[] {
    const now = Date.now();
    const counts: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const end = now - i * WINDOW;
      const start = end - WINDOW;
      counts.push(this.timestamps.filter((t) => t >= start && t < end).length);
    }
    return counts;
  }

  getBaseline(): number {
    return this.getWindowCounts().reduce((sum, c) => sum + c, 0) / 10;
  }

  isSpike(threshold: number, minRate: number, z: number): boolean {
    if (Date.now() - this.startedAt < WARMUP) return false;
    const rate = this.getRate();
    if (rate < minRate) return false;
    const counts = this.getWindowCounts();
    const baseline = counts.reduce((sum, c) => sum + c, 0) / 10;
    if (baseline < 1) return rate >= minRate * 2;
    const sd = Math.sqrt(
      counts.reduce((sum, c) => sum + (c - baseline) ** 2, 0) / counts.length,
    );
    if (sd > 0 && rate >= baseline + z * sd) return true;
    return rate >= baseline * threshold;
  }
}

describe("旧実装との同一性", () => {
  // 再現可能な疑似乱数（mulberry32）
  function rng(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([1, 2, 3, 4, 5])(
    "ランダムな受信列（境界ちょうど・保持期間を超える巻き戻しを含む）で全指標が一致する (seed=%i)",
    (seed) => {
      const rand = rng(seed);
      const d = new RateDetector();
      const ref = new NaiveRateDetector();
      let now = 0;

      for (let step = 0; step < 3000; step++) {
        const r = rand();
        if (r < 0.005) now -= MAX_HISTORY + Math.floor(rand() * 60_000); // 保持期間を超える巻き戻し
        else if (r < 0.02) now -= Math.floor(rand() * 5_000); // 時計の巻き戻し
        else if (r < 0.1) now += WINDOW; // ウィンドウ境界ちょうど
        else if (r < 0.12) now += MAX_HISTORY; // 履歴が全部消える
        else now += Math.floor(rand() * 400);
        vi.setSystemTime(now);

        const n = Math.floor(rand() * 4);
        for (let i = 0; i < n; i++) {
          d.addMessage();
          ref.addMessage();
        }

        expect(d.getRate()).toBe(ref.getRate());
        expect(d.getBaseline()).toBe(ref.getBaseline());
        expect(d.isSpike(8, 5, 2.5)).toBe(ref.isSpike(8, 5, 2.5));
      }
    },
  );
});

describe("高流量", () => {
  it("保持件数が満杯（66,000件）でも件数が正しく、30秒ぶん（6,000件）の受信が500ms未満で終わる", () => {
    vi.useRealTimers(); // performance.now() で実時間を計る
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    // 200 msg/s を保持期間（330秒）ぶん流し込む = 66,000件
    const d = new RateDetector();
    const perSec = 200;
    let now = 0;
    const feedSeconds = (secs: number): void => {
      for (let s = 0; s < secs; s++) {
        for (let i = 0; i < perSec; i++) {
          vi.setSystemTime(now + Math.floor((i * 1000) / perSec));
          d.addMessage();
        }
        now += 1000;
      }
    };

    feedSeconds(MAX_HISTORY / 1000);
    expect(d.getRate()).toBe(perSec * 30);
    expect(d.getBaseline()).toBeCloseTo(perSec * 30, 0); // 最古ウィンドウは開始が -5ms なので 1件少ない

    // 保持件数が満杯の状態で30秒ぶん（6,000件）受信する時間を計る。
    // 新実装はローカル Mac で 1ms 未満、全件走査の旧実装は 1秒以上かかる。
    // CI の遅いランナーや GC でも落ちないよう、上限は新実装に対して大きく余裕を持たせる。
    const t0 = performance.now();
    feedSeconds(30);
    const elapsed = performance.now() - t0;

    expect(d.getRate()).toBe(perSec * 30);
    expect(elapsed).toBeLessThan(500);
  });
});
