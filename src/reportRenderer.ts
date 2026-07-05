import type { SessionWithSamples } from "./timelineRepository.js";

/** SVG のレイアウト定数。viewBox 基準（実表示は width:100% でスケール）。 */
const W = 1000;
const H = 320;
const PAD = { top: 20, right: 20, bottom: 34, left: 52 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

// NOTE: public/app.js にも同等の esc / formatDuration がある（ダッシュボードはブラウザで実行、
// こちらはサーバー側で HTML を生成）。バンドラを持たない構成のため意図的なミラー。片方を変えたら両方直す。
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 経過ミリ秒を「1時間23分」「7分」形式に整形（配信時間の表示用）。 */
function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}

/** 経過ミリ秒を軸ラベル用に整形（1時間以上なら H:MM、未満なら M:SS）。 */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor(totalSec / 60) % 60;
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}` : `${m}:${pad(s)}`;
}

/**
 * 配信セッションを、外部依存のない自己完結 HTML レポートに描画する純粋関数。
 * サンプル（流速）を inline SVG の折れ線（Y軸=件/30秒）で表し、ブラウザで開くだけで波形が見える。
 * DB やファイルへの副作用は持たない。
 */
export function renderHtml(session: SessionWithSamples): string {
  const { id, channel, title, startedAt, endedAt, samples } = session;

  const lastT = samples.length ? samples[samples.length - 1].t : 0;
  const durationMs = Math.max(0, (endedAt ?? startedAt + lastT) - startedAt);
  const peak = samples.reduce((mx, s) => Math.max(mx, s.rate), 0);
  const startedLabel = new Date(startedAt).toLocaleString("ja-JP");

  const chart = renderChart(samples, durationMs, peak);

  const stat = (label: string, value: string) =>
    `<div class="stat"><div class="stat-v">${value}</div><div class="stat-l">${label}</div></div>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(channel)} の振り返り — ChatGust</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0e0e10; color: #efeff1; padding: 24px; line-height: 1.5; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin-bottom: 2px; }
  .sub { color: #adadb8; font-size: 0.85rem; margin-bottom: 4px; word-break: break-word; }
  .when { color: #6b6b7a; font-size: 0.75rem; margin-bottom: 20px; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .stat { background: #1f1f23; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
  .stat-v { font-size: 1.5rem; font-weight: 700; line-height: 1.1; }
  .stat-l { color: #adadb8; font-size: 0.72rem; text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; }
  .panel { background: #1f1f23; border-radius: 12px; padding: 16px; overflow-x: auto; }
  svg { width: 100%; height: auto; display: block; }
  .foot { margin-top: 16px; font-size: 0.8rem; }
  .foot a { color: #a970ff; text-decoration: none; }
  .foot a:hover { text-decoration: underline; }
  .empty { color: #adadb8; padding: 40px 0; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(channel)} の盛り上がり振り返り</h1>
    <p class="sub">${esc(title) || "（タイトルなし）"}</p>
    <p class="when">配信開始 ${startedLabel}</p>

    <div class="stats">
      ${stat("配信時間", formatDuration(durationMs))}
      ${stat("ピーク流速", `${peak}`)}
      ${stat("サンプル数", `${samples.length}`)}
    </div>

    <div class="panel">${chart}</div>

    <p class="foot"><a href="/api/reports/${esc(id)}">JSON を見る</a></p>
  </div>
</body>
</html>
`;
}

/** サンプル配列から折れ線（＋薄い面）と軸を描いた SVG 文字列を返す。 */
function renderChart(
  samples: { t: number; rate: number }[],
  durationMs: number,
  peak: number
): string {
  if (samples.length === 0) {
    return `<p class="empty">サンプルがありません</p>`;
  }

  const tMax = Math.max(durationMs, 1);
  const rMax = Math.max(peak, 1);
  const baseY = PAD.top + PLOT_H;

  const x = (t: number) => PAD.left + (t / tMax) * PLOT_W;
  const y = (r: number) => PAD.top + PLOT_H - (r / rMax) * PLOT_H;

  const pts = samples.map((s) => `${x(s.t).toFixed(1)},${y(s.rate).toFixed(1)}`);

  // 面（折れ線の下を薄く塗る）
  const areaPath =
    `M ${x(samples[0].t).toFixed(1)},${baseY.toFixed(1)} ` +
    pts.map((p) => `L ${p}`).join(" ") +
    ` L ${x(samples[samples.length - 1].t).toFixed(1)},${baseY.toFixed(1)} Z`;

  // Y グリッド＋ラベル。整数の「きりのいい」刻みにして、流速が小さいときにラベルが
  // 重複（例 peak=1 → 0,0,1,1,1）しないようにする。
  const yStep = Math.max(1, Math.ceil(rMax / 4));
  const yValues: number[] = [];
  for (let v = 0; v <= rMax; v += yStep) yValues.push(v);
  const yTicks = yValues
    .map((val) => {
      const yy = y(val);
      return (
        `<line x1="${PAD.left}" y1="${yy.toFixed(1)}" x2="${W - PAD.right}" y2="${yy.toFixed(1)}" class="grid" />` +
        `<text x="${PAD.left - 8}" y="${(yy + 4).toFixed(1)}" class="ylabel">${val}</text>`
      );
    })
    .join("");

  // X ラベル（開始・中間・終了の経過時間）
  const xTicks = [0, 0.5, 1]
    .map((f) => {
      const xx = x(tMax * f);
      const anchor = f === 0 ? "start" : f === 1 ? "end" : "middle";
      return `<text x="${xx.toFixed(1)}" y="${H - 12}" class="xlabel" text-anchor="${anchor}">${formatElapsed(tMax * f)}</text>`;
    })
    .join("");

  // ピーク点を直接ラベル
  const peakSample = samples.reduce((a, b) => (b.rate >= a.rate ? b : a), samples[0]);
  const px = x(peakSample.t);
  const py = y(peakSample.rate);
  const peakLabelAnchor = px > W - 120 ? "end" : "start";
  const peakLabelDx = peakLabelAnchor === "end" ? -10 : 10;
  const peakMark =
    peak > 0
      ? `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" class="peak-dot" />` +
        `<text x="${(px + peakLabelDx).toFixed(1)}" y="${(py - 8).toFixed(1)}" class="peak-label" text-anchor="${peakLabelAnchor}">ピーク ${peak}</text>`
      : "";

  const line =
    samples.length >= 2
      ? `<polyline points="${pts.join(" ")}" class="line" />`
      : `<circle cx="${x(samples[0].t).toFixed(1)}" cy="${y(samples[0].rate).toFixed(1)}" r="3.5" class="peak-dot" />`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="チャット流速の推移（件/30秒）">
  <style>
    .grid { stroke: rgba(255,255,255,0.06); stroke-width: 1; }
    .ylabel { fill: #adadb8; font-size: 11px; text-anchor: end; font-family: system-ui, sans-serif; }
    .xlabel { fill: #adadb8; font-size: 11px; font-family: system-ui, sans-serif; }
    .area { fill: url(#g); }
    .line { fill: none; stroke: #a970ff; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .peak-dot { fill: #a970ff; stroke: #1f1f23; stroke-width: 2; }
    .peak-label { fill: #efeff1; font-size: 12px; font-weight: 600; font-family: system-ui, sans-serif; }
    .axis-title { fill: #6b6b7a; font-size: 11px; font-family: system-ui, sans-serif; }
  </style>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a970ff" stop-opacity="0.28" />
      <stop offset="100%" stop-color="#a970ff" stop-opacity="0" />
    </linearGradient>
  </defs>
  ${yTicks}
  <path d="${areaPath}" class="area" />
  ${line}
  ${peakMark}
  ${xTicks}
  <text x="${PAD.left}" y="14" class="axis-title">件 / 30秒</text>
</svg>`;
}
