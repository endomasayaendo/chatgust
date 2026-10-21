import "dotenv/config";
import { existsSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { parseArgs } from "util";
import { openDb } from "../src/db.js";
import { SqliteTimelineRepository, type Sample, type SessionWithSamples } from "../src/timelineRepository.js";
import { BASELINE_SAMPLES, WARMUP_MS, WINDOW_SECS, judgeSpike, type SpikeParams } from "../src/rateDetector.js";
import { ConsecutiveSpikePolicy } from "../src/spikePolicy.js";
import { Cooldown } from "../src/cooldown.js";

/**
 * 記録済みの流速（samples: 5秒ごとの「直近30秒の件数」）を再生し、検知パラメータごとに
 * 「いつ通知が飛んだか」を算出するバックテスト。判定は本番と同じ judgeSpike / ConsecutiveSpikePolicy /
 * Cooldown を使う。DB のデータは書き換えない（開くのは本番と同じ openDb）。
 *
 *   npm run backtest                                  … 現行パラメータ（.env / 既定値）で全セッション
 *   npm run backtest -- --params z=2.5 --params z=3.5  … 複数のパラメータの組を比較（省略したキーは現行値）
 *   npm run backtest -- --session <id> --db ./data/chatgust.db
 */

export interface BacktestParams extends SpikeParams {
  cooldownMin: number;
}

export interface BacktestAlert {
  /** 通知が飛んだ時刻（UTC ミリ秒） */
  at: number;
  rate: number;
  baseline: number;
}

const WINDOW_MS = WINDOW_SECS * 1000;
/** 「k窓前の時点」のサンプルとして採用する時刻のずれの許容幅（サンプル間隔 5 秒の半分）。 */
const SAMPLE_TOLERANCE_MS = 2_500;

/** t に最も近いサンプルの rate（許容幅内に無ければ 0）。samples は t 昇順。 */
function rateNear(samples: Sample[], t: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  let best: Sample | undefined;
  for (const s of [samples[lo - 1], samples[lo]]) {
    if (s && Math.abs(s.t - t) <= SAMPLE_TOLERANCE_MS && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) {
      best = s;
    }
  }
  return best?.rate ?? 0;
}

/**
 * 時点 t の「直前 BASELINE_SAMPLES 個の30秒窓の件数」を記録から再構成する。
 * k 窓前の件数は、k×30秒前のサンプル（その時点の直近30秒の件数）そのもの。
 * セッション開始前（検知器がまだ無い期間）は 0。
 */
export function reconstructWindowCounts(samples: Sample[], t: number): number[] {
  const counts: number[] = [];
  for (let k = 1; k <= BASELINE_SAMPLES; k++) {
    const target = t - k * WINDOW_MS;
    counts.push(target <= 0 ? 0 : rateNear(samples, target));
  }
  return counts;
}

/** 1セッションの記録を再生し、指定パラメータで通知が飛んだ時刻を返す。 */
export function replaySession(
  session: Pick<SessionWithSamples, "channel" | "startedAt" | "samples">,
  params: BacktestParams
): BacktestAlert[] {
  const policy = new ConsecutiveSpikePolicy();
  let clock = 0;
  const cooldown = new Cooldown(params.cooldownMin * 60 * 1000, () => clock);
  const alerts: BacktestAlert[] = [];

  for (const { t, rate } of session.samples) {
    clock = session.startedAt + t;
    const counts = reconstructWindowCounts(session.samples, t);
    const isSpike = t >= WARMUP_MS && judgeSpike(rate, counts, params);
    if (policy.confirm(session.channel, isSpike) && cooldown.tryAcquire(session.channel)) {
      const baseline = counts.reduce((sum, c) => sum + c, 0) / counts.length;
      alerts.push({ at: clock, rate, baseline });
    }
  }
  return alerts;
}

/** "z=2.5,threshold=8,minRate=5,cooldown=5" を解釈する（省略したキーは base の値）。 */
export function parseParams(spec: string, base: BacktestParams): BacktestParams {
  const keys: Record<string, keyof BacktestParams> = {
    z: "z",
    threshold: "threshold",
    minRate: "minRate",
    cooldown: "cooldownMin",
  };
  const params = { ...base };
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, raw] = pair.split("=");
    const key = keys[name];
    const value = Number(raw);
    if (!key || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid --params "${pair}". Use z / threshold / minRate / cooldown with positive numbers.`);
    }
    params[key] = value;
  }
  return params;
}

/** 現行パラメータ（.env、無ければ本番と同じ既定値）。 */
function currentParams(env: NodeJS.ProcessEnv): BacktestParams {
  return parseParams(
    `z=${env.SPIKE_Z || 3.0},threshold=${env.SPIKE_THRESHOLD || 8},minRate=${env.MIN_RATE || 5},cooldown=${env.COOLDOWN_MIN || 5}`,
    { z: 0, threshold: 0, minRate: 0, cooldownMin: 0 }
  );
}

function jst(ms: number, withDate: boolean): string {
  return new Date(ms).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    ...(withDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function label(p: BacktestParams): string {
  return `z=${p.z} threshold=${p.threshold} minRate=${p.minRate} cooldown=${p.cooldownMin}分`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      session: { type: "string", multiple: true },
      params: { type: "string", multiple: true },
    },
  });

  const dbPath = values.db ?? path.join(process.env.DATA_DIR || "./data", "chatgust.db");
  if (!existsSync(dbPath)) {
    console.error(`✗ DB が見つかりません: ${dbPath}（--db で指定できます）`);
    process.exit(1);
  }

  const current = currentParams(process.env);
  const sets = values.params?.length ? values.params.map((spec) => parseParams(spec, current)) : [current];
  const names = sets.map((_, i) => String.fromCharCode(65 + i)); // A, B, C…

  const db = openDb(dbPath);
  const repo = new SqliteTimelineRepository(db);
  const ids = values.session ?? repo.listReports(Number.MAX_SAFE_INTEGER).map((r) => r.id).reverse();
  const sessions = ids.map((id) => {
    const s = repo.getSession(id);
    if (!s) throw new Error(`session not found: ${id}`);
    return s;
  });
  db.close();

  console.log(`バックテスト: ${dbPath}（${sessions.length} セッション）`);
  console.log(
    "※ 5秒ごとの記録（直近30秒の件数）から判定を再構成した近似です。タイマー発火のずれや" +
      "窓境界（>= / <）の扱いの差により、本番の判定とは厳密には一致しません。\n"
  );
  sets.forEach((p, i) => console.log(`  [${names[i]}] ${label(p)}${p === current ? "（現行）" : ""}`));

  const totals = sets.map(() => ({ alerts: 0, sessionsWithAlert: 0 }));
  let recordedMs = 0;
  for (const s of sessions) {
    const lastT = s.samples.at(-1)?.t ?? 0;
    recordedMs += lastT;
    console.log(`\n■ ${s.channel}「${s.title}」 ${jst(s.startedAt, true)} 〜（${Math.round(lastT / 60000)}分） id=${s.id}`);
    sets.forEach((p, i) => {
      const alerts = replaySession(s, p);
      totals[i].alerts += alerts.length;
      if (alerts.length > 0) totals[i].sessionsWithAlert++;
      const detail = alerts
        .map((a) => `${jst(a.at, false)}（${a.rate}件 / 平常 ${a.baseline.toFixed(1)}）`)
        .join(", ");
      console.log(`  [${names[i]}] ${alerts.length}件${detail ? ": " + detail : ""}`);
    });
  }

  const hours = recordedMs / 3_600_000;
  console.log(`\nパラメータ比較（記録 計 ${hours.toFixed(1)} 時間）`);
  console.log("  組   通知数   通知のあった配信   1時間あたり");
  totals.forEach((t, i) => {
    const perHour = hours > 0 ? (t.alerts / hours).toFixed(2) : "-";
    console.log(
      `  ${names[i].padEnd(4)} ${String(t.alerts).padStart(6)}   ${`${t.sessionsWithAlert}/${sessions.length}`.padStart(16)}   ${perHour.padStart(11)}`
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
