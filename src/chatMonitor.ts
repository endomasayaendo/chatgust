import WebSocket from "ws";
import { RateDetector } from "./rateDetector.js";

export type AlertCallback = (channel: string, rate: number, baseline: number) => void;

interface ChannelState {
  detector: RateDetector;
  title: string;
}

const CHECK_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 10_000;

export class ChatMonitor {
  private ws: WebSocket | null = null;
  private channels = new Map<string, ChannelState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onAlert: AlertCallback;
  private spikeThreshold: number;
  private minRate: number;
  private reconnecting = false;

  constructor(onAlert: AlertCallback, spikeThreshold: number, minRate: number) {
    this.onAlert = onAlert;
    this.spikeThreshold = spikeThreshold;
    this.minRate = minRate;
  }

  private connect(): void {
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;

    ws.on("open", () => {
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK justinfan${Math.floor(Math.random() * 99999)}`);
      for (const channel of this.channels.keys()) {
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
        this.channels.get(match[1])?.detector.addMessage();
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

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [channel, state] of this.channels) {
        if (state.detector.isSpike(this.spikeThreshold, this.minRate)) {
          this.onAlert(channel, state.detector.getRate(), state.detector.getBaseline());
        }
      }
    }, CHECK_INTERVAL_MS);
  }

  join(channel: string, title: string): void {
    if (this.channels.has(channel)) {
      this.channels.get(channel)!.title = title;
      return;
    }
    this.channels.set(channel, { detector: new RateDetector(), title });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this.ws) this.connect();
    } else {
      this.ws.send(`JOIN #${channel}`);
    }
    this.startTimer();
    console.log(`[IRC] Joined #${channel}`);
  }

  part(channel: string): void {
    if (!this.channels.has(channel)) return;
    this.channels.delete(channel);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(`PART #${channel}`);
    }
    console.log(`[IRC] Parted #${channel}`);
  }

  getStatus(): { channel: string; title: string; rate: number; baseline: number }[] {
    return Array.from(this.channels.entries()).map(([channel, state]) => ({
      channel,
      title: state.title,
      rate: state.detector.getRate(),
      baseline: state.detector.getBaseline(),
    }));
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.channels.clear();
    this.ws?.close();
  }
}
