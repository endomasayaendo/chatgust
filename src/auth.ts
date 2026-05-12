import "dotenv/config";
import { createServer } from "http";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

const PORT = 22377;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = "user:read:follows";

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env first.");
  console.error("Create an app at: https://dev.twitch.tv/console/apps");
  process.exit(1);
}

const authUrl =
  `https://id.twitch.tv/oauth2/authorize?` +
  new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
  });

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") return;

      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>Auth complete! You can close this tab.</h2>");
      server.close();
      code ? resolve(code) : reject(new Error("No code in callback"));
    });
    server.listen(PORT, () => {
      console.log(`\nOpen this URL in your browser:\n${authUrl}\n`);
    });
  });
}

async function exchangeCode(code: string): Promise<{ access_token: string; refresh_token: string }> {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID!,
      client_secret: TWITCH_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

async function updateEnv(accessToken: string, refreshToken: string): Promise<void> {
  let content = existsSync(".env") ? await readFile(".env", "utf-8") : "";
  content = content
    .replace(/^TWITCH_ACCESS_TOKEN=.*/m, "")
    .replace(/^TWITCH_REFRESH_TOKEN=.*/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  content += `\nTWITCH_ACCESS_TOKEN=${accessToken}\nTWITCH_REFRESH_TOKEN=${refreshToken}\n`;
  await writeFile(".env", content);
}

const code = await waitForCode();
const tokens = await exchangeCode(code);
await updateEnv(tokens.access_token, tokens.refresh_token);
console.log("Tokens saved to .env. Run npm start to launch ChatPulse!");
