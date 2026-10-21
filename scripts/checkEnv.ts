import { readFileSync, existsSync } from "fs";
import { pathToFileURL } from "url";
import { parse } from "dotenv";

/**
 * `make setup` から呼ぶ .env の検査。必須項目が「未記入／.env.example の見本値のまま／OK」かを判定し、
 * 足りないものには取得場所を案内する。任意項目は未記入でもよいが、見本値のままなら止める。
 * 値そのものは表示しない。
 *
 *   npx tsx scripts/checkEnv.ts
 */

export type EnvStatus = "ok" | "missing" | "placeholder";

export interface EnvCheck {
  key: string;
  status: EnvStatus;
  hint: string;
}

export interface OptionalEnvCheck extends EnvCheck {
  unsetNote: string;
}

/** 自分で書く必須項目と、その取得場所。 */
const REQUIRED: { key: string; hint: string }[] = [
  {
    key: "TWITCH_CLIENT_ID",
    hint: "https://dev.twitch.tv/console/apps › アプリの「管理」›「クライアントID」",
  },
  {
    key: "TWITCH_CLIENT_SECRET",
    hint: "同じ画面の「新しい秘密」で発行（表示は一度きり）",
  },
];

/**
 * 自分で書く任意項目。未記入なら代替動作（unsetNote）で動く。
 * placeholder は以前の .env.example の見本値で、古い .env を写したままの記入漏れを拾うために持つ。
 */
const OPTIONAL: { key: string; hint: string; unsetNote: string; placeholder?: string }[] = [
  {
    key: "DISCORD_WEBHOOK_URL",
    hint: "Discord のチャンネル設定 › 連携サービス › ウェブフック で作成し URL をコピー",
    unsetNote: "通知はコンソールに出力されます",
    placeholder: "https://discord.com/api/webhooks/xxx/yyy",
  },
];

/** `make auth` が書き込む項目。 */
const TOKENS = ["TWITCH_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN"];

function statusOf(value: string | undefined, placeholder: string | undefined): EnvStatus {
  if (!value) return "missing";
  if (placeholder && value === placeholder) return "placeholder";
  return "ok";
}

/** 必須項目を検査する。example は .env.example の中身（見本値の判定に使う）。 */
export function checkRequired(env: Record<string, string>, example: Record<string, string>): EnvCheck[] {
  return REQUIRED.map(({ key, hint }) => ({ key, status: statusOf(env[key], example[key]), hint }));
}

/** 任意項目を検査する。未記入は "missing"（問題なし）、見本値のままなら "placeholder"。 */
export function checkOptional(env: Record<string, string>, example: Record<string, string>): OptionalEnvCheck[] {
  return OPTIONAL.map(({ key, hint, unsetNote, placeholder }) => ({
    key,
    status: statusOf(env[key], example[key] || placeholder),
    hint,
    unsetNote,
  }));
}

/** `make auth` 済みか（トークンが両方入っているか）。 */
export function hasTokens(env: Record<string, string>): boolean {
  return TOKENS.every((key) => Boolean(env[key]));
}

function main(): void {
  if (!existsSync(".env")) {
    console.error("❌ .env がありません。`make setup` で作成してください。");
    process.exit(1);
  }
  const env = parse(readFileSync(".env"));
  const example = existsSync(".env.example") ? parse(readFileSync(".env.example")) : {};

  console.log("\n.env の必須項目:");
  const checks = checkRequired(env, example);
  for (const { key, status, hint } of checks) {
    if (status === "ok") {
      console.log(`  ✅ ${key}`);
    } else {
      const reason = status === "missing" ? "未記入です" : ".env.example の見本の値のままです";
      console.log(`  ❌ ${key} … ${reason}\n     → ${hint}`);
    }
  }

  console.log("\n.env の任意項目:");
  const optional = checkOptional(env, example);
  for (const { key, status, hint, unsetNote } of optional) {
    if (status === "ok") {
      console.log(`  ✅ ${key}`);
    } else if (status === "missing") {
      console.log(`  ➖ ${key} … 未記入（${unsetNote}）\n     → 使うなら: ${hint}`);
    } else {
      console.log(`  ❌ ${key} … 以前の .env.example の見本の値のままです（使わないなら空にする）\n     → ${hint}`);
    }
  }

  const ready =
    checks.every((c) => c.status === "ok") && optional.every((c) => c.status !== "placeholder");
  console.log("\n次にやること:");
  if (!ready) {
    console.log("  .env の ❌ の項目を書いてから、もう一度 `make setup`");
  } else if (!hasTokens(env)) {
    console.log("  `make auth` で Twitch にログイン（トークンが .env に自動で書き込まれます）");
  } else {
    console.log("  準備完了。`make up` で起動");
  }
  console.log("");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
