import { describe, it, expect } from "vitest";
import { ConsecutiveSpikePolicy } from "../src/spikePolicy.js";

describe("ConsecutiveSpikePolicy", () => {
  it("1回目のスパイクだけでは発火しない", () => {
    const p = new ConsecutiveSpikePolicy();
    expect(p.confirm("foo", true)).toBe(false);
  });

  it("2連続でスパイクが続いて初めて発火する", () => {
    const p = new ConsecutiveSpikePolicy();
    expect(p.confirm("foo", true)).toBe(false);
    expect(p.confirm("foo", true)).toBe(true);
  });

  it("間に非スパイクが挟まると連続がリセットされる", () => {
    const p = new ConsecutiveSpikePolicy();
    p.confirm("foo", true);
    expect(p.confirm("foo", false)).toBe(false);
    expect(p.confirm("foo", true)).toBe(false); // 連続1回目に戻る
    expect(p.confirm("foo", true)).toBe(true);
  });

  it("チャンネルごとに独立して状態を持つ", () => {
    const p = new ConsecutiveSpikePolicy();
    expect(p.confirm("foo", true)).toBe(false);
    expect(p.confirm("bar", true)).toBe(false); // foo の状態に影響されない
    expect(p.confirm("foo", true)).toBe(true);
  });

  it("forget で状態を破棄すると連続判定がリセットされる", () => {
    const p = new ConsecutiveSpikePolicy();
    p.confirm("foo", true);
    p.forget("foo");
    expect(p.confirm("foo", true)).toBe(false); // 直前の true は忘れられている
  });
});
