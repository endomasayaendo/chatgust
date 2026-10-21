import { WINDOW_SECS } from "./rateDetector.js";

/**
 * 監視中の配信そのものを指す情報（VOD のタイムスタンプリンク生成に使う）。
 * startedAt は Twitch 上の配信開始時刻（UTC ミリ秒）で、ChatGust が join した時刻ではない。
 * vodId は配信のアーカイブ VOD の id。VOD を保存しないチャンネルや未取得の間は null。
 */
export interface StreamRef {
  streamId: string;
  startedAt: number;
  vodId: string | null;
}

/**
 * VOD の指定位置へ飛ぶ URL（例: https://www.twitch.tv/videos/123?t=1h2m3s）を返す。
 * 書式は Twitch 埋め込みプレイヤーの time パラメータ（既定 0h0m0s）に合わせ、ゼロ埋めしない。
 */
export function vodTimestampUrl(vodId: string, offsetMs: number): string {
  const totalSec = Math.max(0, Math.floor(offsetMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor(totalSec / 60) % 60;
  const s = totalSec % 60;
  return `https://www.twitch.tv/videos/${vodId}?t=${h}h${m}m${s}s`;
}

/**
 * 「windowEndAt で終わる流速の集計窓」の始まりを指す VOD リンクを返す（VOD が無ければ undefined）。
 * 流速は直近 WINDOW_SECS 秒の件数なので、アラート発火時刻やサンプル時刻そのものを指すと
 * 盛り上がりの始まりを過ぎてしまう。窓幅ぶん手前を指して、盛り上がる直前から見られるようにする。
 */
export function vodLinkForWindow(
  stream: StreamRef | null | undefined,
  windowEndAt: number
): string | undefined {
  if (!stream?.vodId) return undefined;
  return vodTimestampUrl(stream.vodId, windowEndAt - WINDOW_SECS * 1000 - stream.startedAt);
}
