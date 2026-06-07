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
    expect(d.isSpike(8, 5)).toBe(false);
  });

  it("レートが minRate 未満なら false", () => {
    const d = new RateDetector();
    vi.setSystemTime(WARMUP + 10_000); // ウォームアップ済み
    for (let i = 0; i < 3; i++) d.addMessage(); // rate=3
    expect(d.isSpike(8, 5)).toBe(false);
  });

  it("baseline < 1 のときは minRate*2 を閾値に使う", () => {
    const d = new RateDetector();
    vi.setSystemTime(WARMUP + 10_000); // 過去ウィンドウは空 → baseline=0

    for (let i = 0; i < 9; i++) d.addMessage(); // rate=9 < minRate*2=10
    expect(d.isSpike(8, 5)).toBe(false);

    d.addMessage(); // rate=10 >= 10
    expect(d.isSpike(8, 5)).toBe(true);
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
    expect(d.isSpike(8, 5)).toBe(true);
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
    expect(d.isSpike(8, 5)).toBe(false);
  });
});
