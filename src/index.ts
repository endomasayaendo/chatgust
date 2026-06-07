import "dotenv/config";
import express from "express";
import basicAuth from "express-basic-auth";
import path from "path";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import {
  getCurrentUser,
  getFollowedChannels,
  getLiveStreams,
  refreshAccessToken,
  TwitchAuthError,
} from "./twitchApi.js";
import { ChatMonitor } from "./chatMonitor.js";
import { sendDiscordAlert } from "./notifier.js";
import { parseAllowlist, filterChannels } from "./notifyFilter.js";

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  DISCORD_WEBHOOK_URL,
  DASHBOARD_PASSWORD,
  NOTIFY_CHANNELS,
  PORT = "3000",
  SPIKE_THRESHOLD = "8",
  SPIKE_Z = "3.0",
  MIN_RATE = "5",
  COOLDOWN_MIN = "5",
} = process.env;

let currentToken = process.env.TWITCH_ACCESS_TOKEN ?? "";
let currentRefreshToken = process.env.TWITCH_REFRESH_TOKEN ?? "";

if (!TWITCH_CLIENT_ID || !currentToken || !DISCORD_WEBHOOK_URL) {
  console.error("Missing required env vars. Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

const spikeThreshold = Number(SPIKE_THRESHOLD);
const spikeZ = Number(SPIKE_Z);
const minRate = Number(MIN_RATE);
const cooldownMin = Number(COOLDOWN_MIN);

if (!Number.isFinite(spikeThreshold) || spikeThreshold <= 0) {
  console.error(`Invalid SPIKE_THRESHOLD: "${SPIKE_THRESHOLD}". Must be a positive number.`);
  process.exit(1);
}
if (!Number.isFinite(spikeZ) || spikeZ <= 0) {
  console.error(`Invalid SPIKE_Z: "${SPIKE_Z}". Must be a positive number.`);
  process.exit(1);
}
if (!Number.isFinite(minRate) || minRate <= 0) {
  console.error(`Invalid MIN_RATE: "${MIN_RATE}". Must be a positive number.`);
  process.exit(1);
}
if (!Number.isFinite(cooldownMin) || cooldownMin <= 0) {
  console.error(`Invalid COOLDOWN_MIN: "${COOLDOWN_MIN}". Must be a positive number.`);
  process.exit(1);
}

// 通知対象の絞り込み（許可リスト）。カンマ区切りのチャンネル login を指定すると、
// そのチャンネルだけを監視・通知する。未設定ならフォロー中のライブ配信すべてが対象。
const notifyChannels = parseAllowlist(NOTIFY_CHANNELS);
if (notifyChannels.size > 0) {
  console.log(`[config] Notify allowlist: ${[...notifyChannels].join(", ")}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "../.env");

async function persistTokens(access: string, refresh: string): Promise<void> {
  if (!existsSync(ENV_PATH)) {
    console.warn("[auth] .env not found — tokens not persisted. On Fly.io, run: flyctl secrets set TWITCH_ACCESS_TOKEN=<new> TWITCH_REFRESH_TOKEN=<new>");
    return;
  }
  let content = await readFile(ENV_PATH, "utf-8");
  content = content
    .replace(/^TWITCH_ACCESS_TOKEN=.*/m, `TWITCH_ACCESS_TOKEN=${access}`)
    .replace(/^TWITCH_REFRESH_TOKEN=.*/m, `TWITCH_REFRESH_TOKEN=${refresh}`);
  await writeFile(ENV_PATH, content);
}

async function doTokenRefresh(): Promise<void> {
  if (!TWITCH_CLIENT_SECRET || !currentRefreshToken) {
    throw new Error("Cannot refresh: TWITCH_CLIENT_SECRET or refresh token missing");
  }
  const result = await refreshAccessToken(TWITCH_CLIENT_ID!, TWITCH_CLIENT_SECRET, currentRefreshToken);
  currentToken = result.accessToken;
  currentRefreshToken = result.refreshToken;
  await persistTokens(currentToken, currentRefreshToken);
  console.log("[auth] Token refreshed");
}

const COOLDOWN_MS = cooldownMin * 60 * 1000;
const POLL_INTERVAL_MS = 60_000;

const alertCooldowns = new Map<string, number>();
const recentAlerts: { channel: string; rate: number; baseline: number; at: string }[] = [];

const monitor = new ChatMonitor(
  (channel, rate, baseline) => {
    const last = alertCooldowns.get(channel) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    alertCooldowns.set(channel, Date.now());

    const entry = { channel, rate, baseline, at: new Date().toISOString() };
    recentAlerts.unshift(entry);
    if (recentAlerts.length > 50) recentAlerts.pop();

    const mult = (rate / Math.max(baseline, 1)).toFixed(1);
    console.log(`[alert] ${channel}: ${rate} msg/30s (${mult}x baseline)`);

    const title = monitor.getStatus().find((s) => s.channel === channel)?.title ?? "";
    sendDiscordAlert(DISCORD_WEBHOOK_URL!, {
      channel,
      title,
      rate,
      baseline,
      streamUrl: `https://twitch.tv/${channel}`,
    }).catch((err: Error) => console.error("[notifier]", err.message));
  },
  spikeThreshold,
  minRate,
  spikeZ
);

let userId = "";

async function syncStreams(): Promise<void> {
  try {
    if (!userId) {
      const user = await getCurrentUser(TWITCH_CLIENT_ID!, currentToken);
      userId = user.id;
    }
    const followed = await getFollowedChannels(TWITCH_CLIENT_ID!, currentToken, userId);
    const targets = filterChannels(followed, notifyChannels);
    const live = await getLiveStreams(TWITCH_CLIENT_ID!, currentToken, targets);

    const liveSet = new Set(live.map((s) => s.login));
    const currentSet = new Set(monitor.getStatus().map((s) => s.channel));

    for (const stream of live) monitor.join(stream.login, stream.title);
    for (const channel of currentSet) {
      if (!liveSet.has(channel)) monitor.part(channel);
    }

    console.log(`[sync] Monitoring ${liveSet.size} live streams`);
  } catch (err) {
    if (err instanceof TwitchAuthError) {
      console.log("[auth] Token expired, attempting refresh...");
      try {
        await doTokenRefresh();
        userId = "";
      } catch (refreshErr) {
        console.error("[auth] Refresh failed:", (refreshErr as Error).message);
      }
      return;
    }
    console.error("[sync] Error:", (err as Error).message);
  }
}

const app = express();

if (DASHBOARD_PASSWORD) {
  app.use(basicAuth({ users: { admin: DASHBOARD_PASSWORD }, challenge: true }));
}

app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/status", (_req, res) => {
  res.json({
    streams: monitor.getStatus(),
    recentAlerts: recentAlerts.slice(0, 20),
    config: {
      spikeThreshold,
      spikeZ,
      minRate,
      cooldownMin,
      notifyChannels: [...notifyChannels],
    },
  });
});

app.listen(Number(PORT), () => {
  console.log(`[server] http://localhost:${PORT}`);
  syncStreams();
  setInterval(syncStreams, POLL_INTERVAL_MS);
});

process.on("SIGINT", () => {
  monitor.destroy();
  process.exit(0);
});
