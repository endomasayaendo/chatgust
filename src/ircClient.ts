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

    // 1フレームに複数行が入ってくる（Twitch はまとめて送る）。行ごとに処理しないと
    // 先頭1件しか数えられず、流速が実際より小さく出てしまう。
    ws.on("message", (data: Buffer) => {
      for (const line of data.toString().split("\r\n")) {
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv");
          continue;
        }
        const match = line.match(/PRIVMSG #(\w+)/);
        if (match) this.onMessage(match[1]);
      }
    });

    ws.on("close", () => {
      // 閉じたソケットを掴んだままにしない。残しておくと、監視対象がゼロのときに
      // 再接続もされず join も素通りして、IRC が永久に無音になる。
      if (this.ws === ws) this.ws = null;

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

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`JOIN #${channel}`);
      return;
    }
    // 接続中なら open ハンドラが、再接続待ちならそのタイマーが、いずれも
    // this.channels の全チャンネルを JOIN する。それ以外（未接続・切断済み）は今つなぐ。
    if (!this.ws && !this.reconnecting) this.connect();
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
