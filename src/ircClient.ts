import WebSocket from "ws";

const RECONNECT_DELAY_MS = 10_000;

/**
 * Twitch IRC（匿名 WebSocket）への接続を管理する。接続・再接続・PING 応答・
 * チャンネルへの JOIN/PART・受信メッセージ（PRIVMSG）のパースを担う。
 * チャットメッセージを受信すると、そのチャンネル名を onMessage(channel) で呼び出し元に渡す。
 */
export class IrcClient {
  private ws: WebSocket | null = null;
  private readonly channels = new Set<string>();
  private reconnecting = false;

  constructor(private readonly onMessage: (channel: string) => void) {}

  private connect(): void {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;

    ws.on("open", () => {
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(Math.random() * 99999)}`);
      for (const channel of this.channels) {
        ws.send(`JOIN #${channel}`);
      }
      console.log(`[IRC] Connected, joined ${this.channels.size} channels`);
    });

    ws.on("message", (data: Buffer) => {
      const msg = data.toString();
      if (msg.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv");
        return;
      }
      const match = msg.match(/PRIVMSG #(\w+)/);
      if (match) {
        this.onMessage(match[1]);
      }
    });

    ws.on("close", () => {
      if (!this.reconnecting && this.channels.size > 0) {
        this.reconnecting = true;
        console.log(`[IRC] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        setTimeout(() => {
          this.reconnecting = false;
          this.connect();
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 未接続なら接続を開始（open ハンドラが全チャンネルを JOIN する）
      if (!this.ws) this.connect();
    } else {
      this.ws.send(`JOIN #${channel}`);
    }
  }

  part(channel: string): void {
    if (!this.channels.delete(channel)) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`PART #${channel}`);
    }
  }

  destroy(): void {
    this.channels.clear();
    this.ws?.close();
  }
}
