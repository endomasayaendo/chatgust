/**
 * スパイク判定の結果からアラートの発火可否を決めるポリシー。
 * チャンネルごとに判定の経過を見て、瞬間的な揺れによる誤検知を抑えながら発火を判断する。
 */
export interface SpikePolicy {
  /** スパイク判定を受け取り、アラートを発火すべきなら true を返す。 */
  confirm(channel: string, isSpike: boolean): boolean;
  /** チャンネルの監視終了時に、そのチャンネルの内部状態を破棄する。 */
  forget(channel: string): void;
}

/**
 * スパイク判定が2回連続したときに初めてアラートを発火するポリシー。
 * 単発のスパイクはノイズとみなして見送り、続いて再びスパイクが出たら発火する。
 */
export class ConsecutiveSpikePolicy implements SpikePolicy {
  private readonly wasSpike = new Map<string, boolean>();

  confirm(channel: string, isSpike: boolean): boolean {
    const prev = this.wasSpike.get(channel) ?? false;
    this.wasSpike.set(channel, isSpike);
    return isSpike && prev;
  }

  forget(channel: string): void {
    this.wasSpike.delete(channel);
  }
}
