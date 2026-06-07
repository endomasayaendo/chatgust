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
