/**
 * Manual OAuth2 Setup — works over remote/tmux sessions.
 *
 * 1. Prints an auth URL for you to open in any browser
 * 2. After granting access, Google redirects to localhost (which fails — that's OK)
 * 3. Copy the FULL URL from the browser address bar and paste it here
 * 4. Script extracts the code and exchanges it for tokens
 *
 * Usage:
 *   CLIENT_ID=... CLIENT_SECRET=... ACCOUNT=personal npx tsx scripts/oauth-manual.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { google } from "googleapis";

const CLIENT_ID = process.env["CLIENT_ID"] ?? "";
const CLIENT_SECRET = process.env["CLIENT_SECRET"] ?? "";
const ACCOUNT = process.env["ACCOUNT"] ?? "";
const REDIRECT_URI = "http://localhost:3000/oauth/callback";

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT) {
    console.error("Usage: CLIENT_ID=... CLIENT_SECRET=... ACCOUNT=personal npx tsx scripts/oauth-manual.ts");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.readonly"],
    prompt: "consent",
  });

  console.log("\n========================================");
  console.log("  Kindle Calendar — OAuth2 Setup");
  console.log(`  Account: ${ACCOUNT}`);
  console.log("========================================\n");
  console.log("1. Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\n2. Sign in and grant calendar access.");
  console.log("3. The browser will redirect to localhost and FAIL — that's expected.");
  console.log("4. Copy the FULL URL from your browser address bar.");
  console.log("   It looks like: http://localhost:3000/oauth/callback?code=4/0AXXXX...&scope=...\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Paste the full redirect URL here: ", resolve);
  });
  rl.close();

  // Extract code from URL or raw code
  let code: string;
  try {
    const url = new URL(answer.trim());
    code = url.searchParams.get("code") ?? "";
  } catch {
    // Maybe they pasted just the code
    code = answer.trim();
  }

  if (!code) {
    console.error("\nError: Could not extract authorization code from the input.");
    process.exit(1);
  }

  console.log("\nExchanging code for tokens...");
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      "\nError: No refresh_token received. Go to https://myaccount.google.com/permissions,\n" +
      "revoke access for this app, then run this script again."
    );
    process.exit(1);
  }

  // Save credentials
  const credDir = path.resolve(__dirname, "..", "credentials");
  fs.mkdirSync(credDir, { recursive: true });

  const outPath = path.join(credDir, `${ACCOUNT}.json`);
  const data = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    account_name: ACCOUNT,
  };

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");

  console.log(`\nCredentials saved to: ${outPath}`);
  console.log("\nAdd this to your config.yaml:\n");
  console.log(`  - id: ${ACCOUNT}`);
  console.log(`    type: google`);
  console.log(`    label: "${ACCOUNT.charAt(0).toUpperCase() + ACCOUNT.slice(1)}"`);
  console.log(`    credentialRef: "${ACCOUNT}"`);
  console.log(`    calendarId: "primary"`);
  console.log(`    displayStyle: solid`);
  console.log("\nDone! Run again with a different ACCOUNT= for additional Google accounts.");
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
