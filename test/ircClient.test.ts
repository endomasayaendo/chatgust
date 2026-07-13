import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * ws を差し替えて IRC 接続のライフサイクル（接続・JOIN・受信・切断・再接続）を検証する。
 * 実ネットワークには一切つながない。
 */
const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (arg?: unknown) => void>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  on(event: string, cb: (arg?: unknown) => void): void {
    this.handlers.set(event, cb);
  }

  send(msg: string): void {
    this.sent.push(msg);
  }

  close(): void {
    this.emitClose();
  }

  /** サーバー側で接続が確立した状態を再現する。 */
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.handlers.get("open")?.();
  }

  /** 接続が切れた状態を再現する（Twitch 側の切断・ネットワーク断など）。 */
  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.handlers.get("close")?.();
  }

  emitMessage(raw: string): void {
    this.handlers.get("message")?.(Buffer.from(raw));
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));

const { IrcClient } = await import("../src/ircClient.js");

const privmsg = (channel: string, text: string) =>
  `:user!user@user.tmi.twitch.tv PRIVMSG #${channel} :${text}\r\n`;

describe("IrcClient", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("join で接続し、open 後に JOIN を送る。PRIVMSG を受けたら onMessage が呼ばれる", () => {
    const received: string[] = [];
    const irc = new IrcClient((c) => received.push(c));

    irc.join("alice");
    expect(sockets).toHaveLength(1);

    sockets[0].emitOpen();
    expect(sockets[0].sent).toContain("JOIN #alice");

    sockets[0].emitMessage(privmsg("alice", "hello"));
    expect(received).toEqual(["alice"]);
  });

  it("接続済みなら、追加の join はその場で JOIN を送る", () => {
    const irc = new IrcClient(() => {});
    irc.join("alice");
    sockets[0].emitOpen();

    irc.join("bob");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toContain("JOIN #bob");
  });

  it("監視中に切断されたら再接続し、全チャンネルを JOIN し直す", () => {
    const irc = new IrcClient(() => {});
    irc.join("alice");
    sockets[0].emitOpen();

    sockets[0].emitClose();
    vi.advanceTimersByTime(10_000);

    expect(sockets).toHaveLength(2);
    sockets[1].emitOpen();
    expect(sockets[1].sent).toContain("JOIN #alice");
  });

  // 監視対象がゼロの間は接続を張り直さない。この「接続なし」状態から復帰できることが、
  // 24時間稼働（全配信終了 → 切断 → 翌日再開）で流速が取れ続ける条件になる。
  it("全チャンネル part 後に切断されても、次の join で接続し直せる", () => {
    const received: string[] = [];
    const irc = new IrcClient((c) => received.push(c));

    irc.join("alice");
    sockets[0].emitOpen();
    irc.part("alice");

    // 監視対象ゼロの状態で接続が切れる（アイドル切断・ネットワーク断）
    sockets[0].emitClose();
    vi.advanceTimersByTime(60_000);

    // 翌日、別の配信が始まる
    irc.join("bob");
    vi.advanceTimersByTime(10_000);

    const live = sockets.find((s) => s.readyState !== FakeWebSocket.CLOSED);
    expect(live, "新しい接続が張られていること").toBeDefined();

    live!.emitOpen();
    expect(live!.sent).toContain("JOIN #bob");

    live!.emitMessage(privmsg("bob", "hello"));
    expect(received).toEqual(["bob"]);
  });

  // 流速の計測はメッセージ1件も落とさないことが前提。Twitch は複数行を1フレームにまとめて送る。
  it("1フレームに複数の PRIVMSG が来たら、すべて数える", () => {
    const received: string[] = [];
    const irc = new IrcClient((c) => received.push(c));
    irc.join("alice");
    sockets[0].emitOpen();

    sockets[0].emitMessage(
      privmsg("alice", "one") + privmsg("alice", "two") + privmsg("alice", "three")
    );

    expect(received).toEqual(["alice", "alice", "alice"]);
  });

  it("PING と PRIVMSG が同じフレームで来ても、PONG を返しつつメッセージを数える", () => {
    const received: string[] = [];
    const irc = new IrcClient((c) => received.push(c));
    irc.join("alice");
    sockets[0].emitOpen();

    sockets[0].emitMessage("PING :tmi.twitch.tv\r\n" + privmsg("alice", "hi"));

    expect(sockets[0].sent).toContain("PONG :tmi.twitch.tv");
    expect(received).toEqual(["alice"]);
  });
});
