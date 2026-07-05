import { describe, it, expect } from "vitest";
import { renderHtml } from "../src/reportRenderer.js";
import type { SessionWithSamples } from "../src/timelineRepository.js";

const base: SessionWithSamples = {
  id: "abc123def456",
  channel: "shroud",
  title: "PUBG ランク",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_000_000 + 3_600_000, // 1時間
  samples: [
    { t: 0, rate: 2 },
    { t: 300_000, rate: 15 },
    { t: 600_000, rate: 40 },
    { t: 900_000, rate: 8 },
  ],
};

describe("renderHtml", () => {
  it("自己完結HTML（doctype始まり・外部リソース参照なし）", () => {
    const html = renderHtml(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);
  });

  it("channel/title と波形の polyline を含む", () => {
    const html = renderHtml(base);
    expect(html).toContain("shroud");
    expect(html).toContain("PUBG ランク");
    expect(html).toContain("<polyline");
    expect(html).toContain("ピーク 40"); // ピークの直接ラベル
  });

  it("JSON へのリンクを含む", () => {
    expect(renderHtml(base)).toContain('href="/api/reports/abc123def456"');
  });

  it("HTML を含む title はエスケープされる", () => {
    const html = renderHtml({ ...base, title: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("サンプル0件でも落ちず、空メッセージを出す", () => {
    const html = renderHtml({ ...base, samples: [], endedAt: base.startedAt });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("サンプルがありません");
  });

  it("サンプル1件は点で描画（polyline なし）", () => {
    const html = renderHtml({ ...base, samples: [{ t: 0, rate: 5 }] });
    expect(html).toContain("<circle");
    expect(html).not.toContain("<polyline");
  });
});
