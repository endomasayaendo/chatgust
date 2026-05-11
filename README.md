# ChatPulse — 設計書

複数のTwitch配信チャットを裏で監視し、急加速した瞬間だけDiscordに通知するツール。
PCの電源に依存しないよう Fly.io に常駐させ、ブラウザのWeb UIで状態を管理できる。

---

## 確定仕様

| 項目 | 決定内容 |
|------|---------|
| 言語 | TypeScript（tsx で開発時実行） |
| 通知先 | Discord Webhook |
| チャンネル取得 | Twitch フォローリスト（1分ごとに自動更新） |
| IRC接続 | 全チャンネルを1本のWebSocketにまとめる（効率化） |
| 実行環境 | Fly.io（無料枠、常時ON） |
| Web UI | ブラウザダッシュボード（チャンネル一覧・リアルタイム流速） |
| OAuth コールバックポート | 22377 |

---

## ファイル構成

```
ChatPulse/
├── package.json          # name: "chatpulse"
├── tsconfig.json
├── fly.toml              # Fly.io デプロイ設定
├── .env.example
├── src/
│   ├── index.ts          # Express サーバー + メインオーケストレーター
│   ├── auth.ts           # 初回のみローカル実行するOAuth取得スクリプト
│   ├── twitchApi.ts      # Twitch REST API（フォロー一覧・ライブ配信取得）
│   ├── chatMonitor.ts    # IRC WebSocket管理（1接続で全チャンネルをJOIN）
│   ├── rateDetector.ts   # スライディングウィンドウ流速計算（チャンネルごと）
│   └── notifier.ts       # Discord Webhook送信
└── public/
    ├── index.html        # Web UI（HTML）
    └── app.js            # Web UI（vanilla JS、5秒ごとに /api/status をポーリング）
```

---

## 主要アルゴリズム

### 急加速検知（rateDetector.ts）

```
直近30秒のメッセージ数  = current_rate
直前10個の30秒ウィンドウの平均 = baseline  （= 直近5分間の平均）

アラート条件:
  current_rate >= baseline × 3   ← 通常の3倍以上
  AND current_rate >= 5          ← 最低5件（過疎チャンネルの誤爆防止）
  AND 同チャンネルの前回アラートから5分以上経過

ベースライン不足時（配信開始直後など）:
  baseline < 1 の場合は current_rate >= 10 を閾値として使用

※ SPIKE_THRESHOLD / MIN_RATE / COOLDOWN_MIN は .env で変更可能
```

### IRC WebSocket（chatMonitor.ts）

- `wss://irc-ws.chat.twitch.tv:443` に1本だけ接続（複数チャンネルを1接続でJOIN）
- `NICK justinfan<ランダム数字>` で認証不要の読み取り専用接続
- 5秒ごとに全チャンネルの流速を確認
- 切断時は10秒後に自動再接続

### ライブストリーム管理（index.ts）

- 起動時 + 1分ごとにフォロー中の配信を取得
- 新たに配信開始 → IRC で `JOIN #channel`
- 配信終了 → IRC で `PART #channel`

### Web UI（public/）

- `GET /api/status` → 監視中チャンネル一覧・現在の流速・最新アラート履歴を JSON で返す
- `public/app.js` が5秒ごとにポーリング → カードを更新
- カードの色: 通常=緑、2倍=黄、3倍以上=赤

---

## セットアップ手順（完成後）

```
【初回セットアップ：ローカルで実行】
1. https://dev.twitch.tv/console/apps でアプリ作成
   リダイレクトURL: http://localhost:22377/callback

2. .env.example を .env にコピーして Client ID / Secret を記入
3. Discord チャンネルで Webhook URL を作成して .env に追記
4. npx tsx src/auth.ts → ブラウザでTwitch認証 → .env にトークン自動保存

【Fly.io へデプロイ】
5. flyctl auth login
6. flyctl launch
7. flyctl secrets import < .env
8. flyctl deploy

【以後】
- https://<app-name>.fly.dev  でダッシュボードを確認
- Discord にアラートが届く
```

---

## Discord 通知イメージ

```
🔥 shroud のチャットが盛り上がってる！
────────────────────────
直近30秒: 87 メッセージ
通常の 5.2倍 ｜ ベースライン: 16.7件
配信を見る → https://twitch.tv/shroud
```

---

## 未決事項（明日以降）

- [ ] 実装スタート（ステップ1から順に許可をもらいながら進める）
