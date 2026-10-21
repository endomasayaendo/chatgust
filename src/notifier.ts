import type { EndReason, FinishedSession } from "./timelineRecorder.js";
import { vodLinkForWindow } from "./vod.js";

export interface AlertPayload {
  channel: string;
  title: string;
  rate: number;
  baseline: number;
  streamUrl: string;
  /** 盛り上がり始めを指す VOD のタイムスタンプリンク（VOD が無ければ undefined）。 */
  vodUrl?: string;
}

/** 配信終了時の振り返りレポート通知のペイロード。 */
export interface ReportPayload {
  channel: string;
  title: string;
  url: string;
  durationMin: number;
  peakRate: number;
  endReason: EndReason;
  /** ピークの場面を指す VOD のタイムスタンプリンク（VOD が無ければ undefined）。 */
  peakVodUrl?: string;
}

/**
 * アラートの通知先を表すインターフェース。
 * 送信先（Discord、Slack など）ごとに send を実装する。
 */
export interface Notifier {
  send(payload: AlertPayload): Promise<void>;
}

/**
 * 振り返りレポートの通知先を表すインターフェース。
 * 配信終了時に、波形レポートへのリンクを送る（通知系の Notifier とは別系統）。
 */
export interface ReportNotifier {
  sendReport(payload: ReportPayload): Promise<void>;
}

/** Discord Webhook へアラートと振り返りレポートを送信する実装。 */
export class DiscordNotifier implements Notifier, ReportNotifier {
  constructor(private readonly webhookUrl: string) {}

  send(payload: AlertPayload): Promise<void> {
    return sendDiscordAlert(this.webhookUrl, payload);
  }

  sendReport(payload: ReportPayload): Promise<void> {
    return sendDiscordReport(this.webhookUrl, payload);
  }
}

export async function sendDiscordAlert(
  webhookUrl: string,
  { channel, title, rate, baseline, streamUrl, vodUrl }: AlertPayload
): Promise<void> {
  const multiplier = baseline > 0 ? (rate / baseline).toFixed(1) : "∞";
  const links = [`[配信を見る](${streamUrl})`];
  if (vodUrl) links.push(`[この場面を VOD で見る](${vodUrl})`);

  const payload = {
    embeds: [
      {
        title: `${channel} のチャットが盛り上がってる！`,
        description: `**${escapeMarkdown(title)}**\n${links.join(" ・ ")}`,
        color: 0xff4500,
        fields: [
          { name: "直近30秒", value: `${rate} メッセージ`, inline: true },
          { name: "通常の", value: `${multiplier}倍`, inline: true },
          { name: "ベースライン", value: `${baseline.toFixed(1)} 件/30秒`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await postToDiscord(webhookUrl, payload, "webhook");
}

export async function sendDiscordReport(
  webhookUrl: string,
  { channel, title, url, durationMin, peakRate, endReason, peakVodUrl }: ReportPayload
): Promise<void> {
  // 配信中に ChatGust が終了した場合は、配信終了と誤解させないよう見出しを分ける。
  const interrupted = endReason === "shutdown";
  const payload = {
    embeds: [
      {
        title: interrupted
          ? `⏸ ${channel} の振り返り（ChatGust 再起動のため途中まで）`
          : `🎬 ${channel} の配信が終了 — 振り返り`,
        description: `**${escapeMarkdown(title)}**\n[振り返りを見る](${url})`,
        color: 0x9146ff,
        fields: [
          { name: interrupted ? "記録時間" : "配信時間", value: `${durationMin} 分`, inline: true },
          {
            name: "ピーク流速",
            value: peakVodUrl
              ? `${peakRate} 件/30秒（[VOD で見る](${peakVodUrl})）`
              : `${peakRate} 件/30秒`,
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await postToDiscord(webhookUrl, payload, "report webhook");
}

/** 確定したセッションと公開URLの基点から、レポート通知のペイロードを組み立てる。 */
export function buildReportPayload(session: FinishedSession, baseUrl: string): ReportPayload {
  return {
    channel: session.channel,
    title: session.title,
    url: `${baseUrl}/reports/${session.id}`,
    durationMin: Math.round((session.endedAt - session.startedAt) / 60000),
    peakRate: session.peakRate,
    endReason: session.endReason,
    peakVodUrl: session.peakAt === null ? undefined : vodLinkForWindow(session.stream, session.peakAt),
  };
}

/** Discord Webhook へ JSON を POST し、失敗時はログする（送信処理の共通部分）。 */
async function postToDiscord(webhookUrl: string, payload: unknown, label: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`[notifier] Discord ${label} failed: ${res.status} ${await res.text()}`);
  }
}

/** Discord マークダウンの特殊文字をエスケープし、タイトル等からのリンク/装飾インジェクションを防ぐ。 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_~|[\]<>]/g, "\\$&");
}
