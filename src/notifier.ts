export interface AlertPayload {
  channel: string;
  title: string;
  rate: number;
  baseline: number;
  streamUrl: string;
}

export async function sendDiscordAlert(
  webhookUrl: string,
  { channel, title, rate, baseline, streamUrl }: AlertPayload
): Promise<void> {
  const multiplier = baseline > 0 ? (rate / baseline).toFixed(1) : "∞";

  const payload = {
    embeds: [
      {
        title: `${channel} のチャットが盛り上がってる！`,
        description: `**${title}**\n[配信を見る](${streamUrl})`,
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

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`[notifier] Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}
