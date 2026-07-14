import WebSocket from "ws";

const RECONNECT_DELAY_MS = 10_000;
/** ハンドシェイクが返ってこないまま CONNECTING で固まるのを防ぐ（close→再接続経路に乗せる）。 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Twitch IRC（匿名 WebSocket）への接続を管理する。接続・再接続・PING 応答・
 * チャンネルへの JOIN/PART・受信メッセージ（PRIVMSG）のパースを担う。
 * チャットメッセージを受信すると、そのチャンネル名を onMessage(channel) で呼び出し元に渡す。
 */
export class IrcClient {
  private ws: WebSocket | null = null;
  private readonly channels = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onMessage: (channel: string) => void) {}

  private connect(): void {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443", {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    this.ws = ws;

    ws.on("open", () => {
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(Math.random() * 99999)}`);
      for (const channel of this.channels) {
        ws.send(`JOIN #${channel}`);
      }
      console.log(`[IRC] Connected, joined ${this.channels.size} channels`);
    });

    // Twitch は複数の IRC 行を1フレームにまとめて送ってくる。1行 = 1メッセージ。
    ws.on("message", (data: Buffer) => {
      for (const line of data.toString().split("\r\n")) {
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv");
          continue;
        }
        const match = line.match(/PRIVMSG #(\w+)/);
        // 1行の処理失敗でフレームごと落とさない（受信は止めてはいけない）。
        if (match) {
          try {
            this.onMessage(match[1]);
          } catch (err) {
            console.error("[IRC] onMessage failed:", (err as Error).message);
          }
        }
      }
    });

    ws.on("close", () => {
      // 不変条件: this.ws は生きている接続だけを指し、未接続なら null（join がこれを見て判断する）。
      if (this.ws === ws) this.ws = null;

      // 監視対象がある間だけ接続を維持する。ゼロなら次の join まで張り直さない。
      if (!this.reconnectTimer && this.channels.size > 0) {
        console.log(`[IRC] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          // 待っている間に全配信が終わっていることがある。close 側と同じ条件で判断する。
          if (this.channels.size > 0) this.connect();
        }, RECONNECT_DELAY_MS);
      }
    });

    ws.on("error", (err: Error) => {
      console.error("[IRC] WebSocket error:", err.message);
    });
  }

  join(channel: string): void {
    if (this.channels.has(channel)) return;
    this.channels.add(channel);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`JOIN #${channel}`);
      return;
    }
    // 接続中なら open ハンドラが、再接続待ちならそのタイマーが、this.channels を丸ごと JOIN する。
    // どちらでもない（＝未接続）ときだけ、ここで張る。
    if (!this.ws && !this.reconnectTimer) this.connect();
  }

  part(channel: string): void {
    if (!this.channels.delete(channel)) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`PART #${channel}`);
    }
  }

  destroy(): void {
    // 保留中の再接続を先に解除する。残すと、破棄したはずのクライアントが後から接続を張り直す。
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.channels.clear();
    this.ws?.close();
  }
}
