# アーキテクチャ / 処理フロー

chatgust は、Twitch のフォロー中ライブ配信を監視し、チャットが「普段より」盛り上がった瞬間を検知して Discord に通知するアプリ。動いているのは **3 つの独立したループ**で、それぞれ別の間隔で回り続ける。

| ループ | 間隔 | 仕事 |
| --- | --- | --- |
| 同期ループ | 60 秒ごと | 今ライブ中の配信を取得し、監視対象を join / part する |
| IRC 受信 | イベント駆動 | チャットが届くたびに受信時刻を記録する |
| 検知ループ | 5 秒ごと | 各チャンネルの盛り上がりを判定し、確定したら通知へ |

## 全体像

```mermaid
flowchart TD
    subgraph boot["起動 · index.ts（composition root）"]
        A["loadConfig()<br/>不正なら process.exit(1)"] --> B["依存を生成・配線<br/>TokenStore → Notifier → Dispatcher<br/>→ ChatMonitor → StreamSync → server"]
        B --> C["app.listen(port)<br/>初回 sync() + setInterval(sync, 60s)"]
    end

    C --> D{{"同期ループ · 60秒ごと<br/>streamSync.sync()"}}
    D --> E["Twitch API: フォロー中 → 許可リスト絞り込み<br/>→ ライブ配信を取得"]
    E --> F["live ごとに monitor.join(login, title)<br/>ライブ外は monitor.part()"]

    F --> G["channels Map に登録<br/>+ IRC へ JOIN + 検知タイマー起動（1本のみ）"]

    G --> H{{"IRC受信 · イベント駆動<br/>ircClient.onMessage"}}
    H --> I["RateDetector.addMessage()<br/>受信時刻を記録"]

    G --> J{{"検知ループ · 5秒ごと<br/>chatMonitor 内 setInterval"}}
    I -. rate/baseline の材料 .-> J
    J --> K["RateDetector.isSpike()<br/>rate が baseline+z×σ を超えたら true"]
    K --> L["SpikePolicy.confirm()<br/>2回連続で初めて確定"]
    L -->|確定| M["Dispatcher.dispatch()<br/>cooldown 抑制 + 履歴記録"]
    M --> N["Discord Webhook へ POST"]
```

## シーケンス図

```mermaid
sequenceDiagram
    autonumber
    participant IDX as index.ts
    participant SS as StreamSync
    participant API as Twitch API
    participant CM as ChatMonitor
    participant IRC as IrcClient
    participant RD as RateDetector
    participant SP as SpikePolicy
    participant AD as Dispatcher
    participant DC as Discord

    IDX->>SS: sync() 初回 + setInterval(60s)

    loop 同期 · 60秒ごと
        SS->>API: getFollowed / getLiveStreams()
        API-->>SS: live: { login, title }[]
        SS->>CM: join(login, title)  ← channel/title の源流
        CM->>IRC: join → WebSocket JOIN
    end

    loop IRC受信 · イベント駆動
        IRC->>CM: onMessage(channel)
        CM->>RD: addMessage() 受信時刻を記録
    end

    loop 検知 · 5秒ごと（各チャンネル）
        CM->>RD: isSpike(threshold, minRate, z)
        RD-->>CM: true / false
        CM->>SP: confirm(channel, isSpike)
        SP-->>CM: 発火可否（2回連続で true）
        alt 発火が確定した場合
            CM->>AD: onAlert → dispatch(channel, rate, baseline, title)
            AD->>AD: cooldown 判定 + 履歴を記録
            AD->>DC: send() Webhook POST
        end
    end
```

## 各メッセージのソース位置

| # | 処理 | 位置 |
| --- | --- | --- |
| 1 | listen 成功後に初回 sync、以降 60 秒間隔で登録 | `index.ts:59-60` |
| 2 | フォロー中 → 許可リスト絞り込み → ライブ取得 | `streamSync.ts:52-54` |
| 3 | 戻り値 `Stream[]`（login・title を含む） | `streamSync.ts:54` |
| 4 | `monitor.join(stream.login, stream.title)` | `streamSync.ts:59` |
| 5 | IRC へ JOIN | `chatMonitor.ts:64` → `ircClient.ts:58` |
| 6 | PRIVMSG をパースし `onMessage(channel)` | `ircClient.ts:38` |
| 7 | `addMessage()` で受信時刻を記録 | `chatMonitor.ts:37-38` → `rateDetector.ts:21` |
| 8 | 5 秒ごとの `isSpike()` | `chatMonitor.ts:49` → `rateDetector.ts:66` |
| 9 | z スコア／乗算フォールバックで真偽を返す | `rateDetector.ts:80` |
| 10 | `confirm()` | `chatMonitor.ts:50` → `spikePolicy.ts:19` |
| 11 | `isSpike && prev`（2 回連続で true） | `spikePolicy.ts:22` |
| 12 | コールバック経由で dispatch | `chatMonitor.ts:51` → `index.ts:41` → `alertDispatcher.ts:27` |
| 13 | cooldown 通過時のみ履歴記録 | `alertDispatcher.ts:28-37` |
| 14 | Discord embed を送信 | `alertDispatcher.ts:39` → `notifier.ts:26` |

## 設計メモ

- **fail-fast の集約** — 設定不正で終了するのは `loadConfig()` の 1 か所だけ。以降の部品は「設定は正しい」前提で書ける。
- **依存性逆転** — `ChatMonitor` は `Dispatcher` を直接知らず、`onAlert` コールバック経由で疎結合（`index.ts:41`）。
- **タイマーは常に 1 本** — `chatMonitor.ts:45` の `if (this.timer) return` が二重起動を防ぐ。
- **配信規模に依存しない検知** — 「平均 + ばらつき(σ)」の z スコアで判定し、小規模〜大手まで同じ基準で効く（`rateDetector.ts:66-84`）。
- **自己修復** — トークン失効(401)を検知したら `TokenStore.refresh()` し、次サイクルで userId を取り直す（`streamSync.ts:66-74`）。
