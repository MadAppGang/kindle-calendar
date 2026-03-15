/**
 * OAuth2 Setup CLI
 *
 * Guides you through obtaining a Google OAuth2 refresh_token for a calendar account.
 * Run once per account:
 *
 *   npx tsx scripts/oauth-setup.ts
 *
 * Writes credentials to: credentials/{accountName}.json
 * The account name should match the `credentialRef` value in your config.yaml.
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { exec } from "child_process";
import { google } from "googleapis";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth/callback`;
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function openBrowser(url: string): void {
  exec(`open "${url}"`, (err) => {
    if (err) {
      console.log("  Could not open browser automatically. Open the URL manually.");
    }
  });
}

/**
 * Starts a temporary HTTP server on localhost:{REDIRECT_PORT} and waits for
 * the OAuth callback. Returns the `code` query parameter from the redirect URL.
 */
function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authorization denied</h2><p>${error}</p><p>You may close this tab.</p></body></html>`
        );
        server.close();
        reject(new Error(`OAuth authorization denied: ${error}`));
        return;
      }

      if (!code) {
        // Not the callback path — ignore
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h2>Authorization successful!</h2><p>You may close this tab and return to the terminal.</p></body></html>`
      );
      server.close();
      resolve(code);
    });

    server.on("error", (err) => {
      reject(
        new Error(
          `Failed to start callback server on port ${REDIRECT_PORT}: ${err.message}. ` +
          "Make sure nothing else is using that port."
        )
      );
    });

    server.listen(REDIRECT_PORT, "localhost", () => {
      console.log(`  Listening for OAuth callback on http://localhost:${REDIRECT_PORT}/oauth/callback`);
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("\nKindle Calendar — Google OAuth2 Setup\n");
    console.log("This tool will help you authorize access to a Google Calendar account.");
    console.log("You will need a Google OAuth2 client_id and client_secret from Google Cloud Console.\n");

    // Step 1: Account name
    const accountName = await prompt(
      rl,
      'Enter an account name (e.g. "personal" or "work"). This will be the credentialRef in config.yaml: '
    );
    if (!accountName) {
      throw new Error("Account name cannot be empty.");
    }

    // Step 2: Credentials
    const envClientId = process.env["GOOGLE_CLIENT_ID"] ?? "";
    const envClientSecret = process.env["GOOGLE_CLIENT_SECRET"] ?? "";

    let clientId: string;
    let clientSecret: string;

    if (envClientId && envClientSecret) {
      console.log("\nUsing credentials from environment variables GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
      clientId = envClientId;
      clientSecret = envClientSecret;
    } else {
      console.log(
        "\nNo GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET environment variables found. Enter them manually."
      );
      clientId = await prompt(rl, "Google OAuth2 client_id: ");
      clientSecret = await prompt(rl, "Google OAuth2 client_secret: ");
    }

    if (!clientId || !clientSecret) {
      throw new Error("client_id and client_secret are required.");
    }

    // Step 3: Generate authorization URL
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent", // force consent screen to always get refresh_token
    });

    console.log("\nStep 1 of 2: Authorize access in your browser.");
    console.log(`  Opening: ${authUrl}\n`);
    openBrowser(authUrl);

    // Step 4: Wait for callback
    console.log("Waiting for authorization... (complete the flow in your browser)");
    const code = await waitForAuthCode();
    console.log("\nAuthorization code received. Exchanging for tokens...");

    // Step 5: Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token in response. This can happen if you have already authorized this app. " +
        "Go to https://myaccount.google.com/permissions and revoke access, then run this script again."
      );
    }

    // Step 6: Save credentials
    const credentialsDir = path.resolve(__dirname, "..", "credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });

    const outputPath = path.join(credentialsDir, `${accountName}.json`);
    const credentialsData = {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      account_name: accountName,
    };

    fs.writeFileSync(outputPath, JSON.stringify(credentialsData, null, 2) + "\n", "utf8");

    console.log(`\nCredentials saved to: ${outputPath}`);
    console.log("\nSetup complete! Add this to your config.yaml calendars section:");
    console.log(`
  - id: ${accountName}
    type: google
    label: "${accountName.charAt(0).toUpperCase() + accountName.slice(1)}"
    credentialRef: "${accountName}"
    calendarId: "primary"
    displayStyle: solid
`);
    console.log("Then restart the dev server: npm run dev");
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nError: ${message}`);
  process.exit(1);
});
