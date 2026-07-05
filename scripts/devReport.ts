import "dotenv/config";
import path from "path";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository } from "../src/timelineRepository.js";
import { TimelineRecorder } from "../src/timelineRecorder.js";
import { DiscordNotifier, buildReportPayload } from "../src/notifier.js";
import { createServer } from "../src/server.js";

/**
 * 開発環境での手動確認用ハーネス。実物のサーバー・DB・Discord通知を使い、
 * ダミーの「完了した配信」を1本注入して、振り返りリンクを実際にクリック確認できるようにする。
 *
 *   npm run dev:report            … DBに入れてローカルで /reports/:id を配信（Discordは送らない）
 *   npm run dev:report -- --notify … さらに Discord に振り返りリンクを1通送る（到達確認）
 *
 * 使い捨ての別DB（data-dev/）に隔離するため、通常運用の data/ は汚れない。Ctrl+C で終了。
 */

const notify = process.argv.includes("--notify");
const PORT = Number(process.env.PORT ?? 3000);

// リンクは常にこのローカルハーネスを指す。ダミーレポートは data-dev/ にしか存在しないため、
// 本番の PUBLIC_BASE_URL（Fly のURL等）を使うと Discord のリンクが本番に飛んで 404 になる。
// LAN の別端末から開きたい場合だけ DEV_PUBLIC_BASE_URL で上書きする。
const baseUrl = process.env.DEV_PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// 本番と別のチャンネルで確認したいときは DEV_DISCORD_WEBHOOK_URL を使う。
// 無ければ本番の DISCORD_WEBHOOK_URL にフォールバック（本番チャンネルに届く点に注意）。
const devWebhook = process.env.DEV_DISCORD_WEBHOOK_URL;
const webhook = devWebhook ?? process.env.DISCORD_WEBHOOK_URL ?? "";
if (notify && !devWebhook && webhook) {
  console.warn(
    "⚠ DEV_DISCORD_WEBHOOK_URL が未設定のため、本番と同じ DISCORD_WEBHOOK_URL に送信します（本番チャンネルにテスト投稿が届きます）。"
  );
}

// 例外を握りつぶさず必ず表示する
process.on("uncaughtException", (e) => {
  console.error("✗ 例外で停止:", e instanceof Error ? e.message : e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("✗ 未処理のPromiseで停止:", e instanceof Error ? e.message : e);
  process.exit(1);
});

console.log(`dev:report 起動中… (PORT=${PORT}, notify=${notify})`);

// 使い捨ての開発用DB（本番/通常の data/ は汚さない）。openDb がディレクトリごと作る。
// 毎回まっさらな1本にするため、ファイル削除ではなく SQL で行だけ消す（滞留させない）。
const db = openDb(path.join(path.resolve("./data-dev"), "chatgust.db"));
db.exec("DELETE FROM samples; DELETE FROM sessions;");
const repo = new SqliteTimelineRepository(db);
const notifier = new DiscordNotifier(webhook);

// 実物の TimelineRecorder に、時刻を差し込んで 25 分ぶんのダミー波形を記録させる
const start = Date.now() - 25 * 60 * 1000;
let clock = start;
let reportUrl = ""; // onPart で確定した直リンクを、起動後のまとめ表示で使う
let discordSent = false;

const recorder = new TimelineRecorder(
  repo,
  (s) => {
    const payload = buildReportPayload(s, baseUrl);
    reportUrl = payload.url;
    if (notify && webhook) {
      notifier
        .sendReport(payload)
        .then(() => console.log("💬 Discord に振り返りリンクを送信しました"))
        .catch((e: Error) => console.error("💬 Discord 送信失敗:", e.message));
      discordSent = true;
    } else if (notify) {
      console.error("💬 送信先 Webhook が未設定のため Discord 送信をスキップ");
    }
  },
  () => clock
);

recorder.onJoin("demo_channel", "デモ配信 — 神回ハイライト");
const N = 300; // 5秒 × 300 = 25分
for (let i = 0; i <= N; i++) {
  clock = start + i * 5000;
  const min = (i * 5000) / 60000;
  const base = 6 + 3 * Math.sin(min / 3);
  const peak1 = 45 * Math.exp(-((min - 8) ** 2) / 2);
  const peak2 = 30 * Math.exp(-((min - 18) ** 2) / 1.2);
  recorder.onSample("demo_channel", Math.max(0, Math.round(base + peak1 + peak2)));
}
clock = start + N * 5000;
recorder.onPart("demo_channel"); // ← ここで reportSink（上）が発火

// 実物のサーバーで配信（Discordリンク／ブラウザの着地点）
const app = createServer({
  monitor: { getStatus: () => [] } as never,
  dispatcher: { getRecentAlerts: () => [] } as never,
  config: { dashboardPassword: undefined } as never,
  repo,
});

const server = app.listen(PORT, () => {
  const line = "-".repeat(52);
  console.log(`\n${line}`);
  console.log("✅ ダミーの完了配信を用意しました。下のどちらからでも波形を開けます:");
  console.log(`   📊 レポート直リンク: ${reportUrl}`);
  console.log(`   🖥  ダッシュボード:   ${baseUrl}/   （「過去の配信レポート」からクリック）`);
  if (notify && discordSent) console.log("   💬 Discord にも同じリンクを送信済み");
  console.log(line);
  console.log("開発用DBは data-dev/ に隔離（消してOK）。Ctrl+C で終了。");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `✗ ポート ${PORT} は使用中です。npm start を止めるか、別ポートで実行してください:\n` +
        `    PORT=3999 npm run dev:report`
    );
  } else {
    console.error("✗ サーバー起動エラー:", err.message);
  }
  process.exit(1);
});

process.on("SIGINT", () => {
  server.close();
  db.close();
  process.exit(0);
});
