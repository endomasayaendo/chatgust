import type { EndReason, FinishedSession } from "./timelineRecorder.js";

export interface AlertPayload {
  channel: string;
  title: string;
  rate: number;
  baseline: number;
  streamUrl: string;
}

/** 配信終了時の振り返りレポート通知のペイロード。 */
export interface ReportPayload {
  channel: string;
  title: string;
  url: string;
  durationMin: number;
  peakRate: number;
  endReason: EndReason;
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

/**
 * Discord を設定していないとき（開発中など）の代替。通知内容をコンソールに出力する。
 * Webhook を作らなくても、どんな通知が飛ぶかをその場で確認できる。
 */
export class ConsoleNotifier implements Notifier, ReportNotifier {
  async send({ channel, title, rate, baseline, streamUrl }: AlertPayload): Promise<void> {
    console.log(
      `[notify] 🔥 ${channel} のチャットが盛り上がってる！「${title}」` +
        ` 直近30秒 ${rate} メッセージ（通常の${formatMultiplier(rate, baseline)}倍・ベースライン ${baseline.toFixed(1)} 件/30秒） ${streamUrl}`
    );
  }

  async sendReport(payload: ReportPayload): Promise<void> {
    const durationLabel = payload.endReason === "shutdown" ? "記録時間" : "配信時間";
    console.log(
      `[notify] ${reportHeading(payload)}「${payload.title}」` +
        ` ${durationLabel} ${payload.durationMin} 分・ピーク流速 ${payload.peakRate} 件/30秒 ${payload.url}`
    );
  }
}

/** 通知先を選ぶ。Webhook が無ければ（開発中など）その旨をログし、コンソールに出す。 */
export function createNotifier(webhookUrl: string | undefined): Notifier & ReportNotifier {
  if (webhookUrl) return new DiscordNotifier(webhookUrl);
  console.log("[config] Discord 未設定のため通知はコンソールに出力します（DISCORD_WEBHOOK_URL）");
  return new ConsoleNotifier();
}

export async function sendDiscordAlert(
  webhookUrl: string,
  { channel, title, rate, baseline, streamUrl }: AlertPayload
): Promise<void> {
  const payload = {
    embeds: [
      {
        title: `${channel} のチャットが盛り上がってる！`,
        description: `**${escapeMarkdown(title)}**\n[配信を見る](${streamUrl})`,
        color: 0xff4500,
        fields: [
          { name: "直近30秒", value: `${rate} メッセージ`, inline: true },
          { name: "通常の", value: `${formatMultiplier(rate, baseline)}倍`, inline: true },
          { name: "ベースライン", value: `${baseline.toFixed(1)} 件/30秒`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await postToDiscord(webhookUrl, payload, "webhook");
}

export async function sendDiscordReport(webhookUrl: string, report: ReportPayload): Promise<void> {
  const { title, url, durationMin, peakRate, endReason } = report;
  const interrupted = endReason === "shutdown";
  const payload = {
    embeds: [
      {
        title: reportHeading(report),
        description: `**${escapeMarkdown(title)}**\n[振り返りを見る](${url})`,
        color: 0x9146ff,
        fields: [
          { name: interrupted ? "記録時間" : "配信時間", value: `${durationMin} 分`, inline: true },
          { name: "ピーク流速", value: `${peakRate} 件/30秒`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await postToDiscord(webhookUrl, payload, "report webhook");
}

/** ベースライン比の倍率（ベースライン 0 なら ∞）。 */
function formatMultiplier(rate: number, baseline: number): string {
  return baseline > 0 ? (rate / baseline).toFixed(1) : "∞";
}

/** 振り返りレポートの見出し。配信中に ChatGust が終了した場合は、配信終了と誤解させないよう分ける。 */
function reportHeading({ channel, endReason }: ReportPayload): string {
  return endReason === "shutdown"
    ? `⏸ ${channel} の振り返り（ChatGust 再起動のため途中まで）`
    : `🎬 ${channel} の配信が終了 — 振り返り`;
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
