import * as fs from "fs";
import * as path from "path";
import { GoogleCredentials } from "../providers/calendar/google.source";

/**
 * Resolves the path to the credentials directory.
 * Looks for a `credentials/` folder relative to the project root
 * (one level above the `functions/` directory).
 */
function credentialsDir(): string {
  // __dirname is functions/src/secrets at runtime
  // Go up: src/secrets -> src -> functions -> project root
  return path.resolve(__dirname, "..", "..", "..", "credentials");
}

/**
 * Loads OAuth2 credentials from a local JSON file.
 *
 * For local development, credentials are stored as:
 *   credentials/{credentialRef}.json
 *
 * where `credentialRef` matches the value in config.yaml (e.g. "kindle-cal-oauth-personal").
 *
 * @param credentialRef - The credentialRef value from CalendarSourceConfig
 * @returns Parsed GoogleCredentials
 * @throws If the file does not exist or cannot be parsed
 */
export function loadCredentials(credentialRef: string): GoogleCredentials {
  const dir = credentialsDir();
  const filePath = path.join(dir, `${credentialRef}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Credentials file not found: ${filePath}. ` +
      `Run npx tsx scripts/oauth-setup.ts to generate credentials for "${credentialRef}".`
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read credentials file ${filePath}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse credentials file ${filePath}: ${msg}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Credentials file ${filePath} must contain a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["client_id"] !== "string" || !obj["client_id"]) {
    throw new Error(`Credentials file ${filePath} is missing "client_id"`);
  }
  if (typeof obj["client_secret"] !== "string" || !obj["client_secret"]) {
    throw new Error(`Credentials file ${filePath} is missing "client_secret"`);
  }
  if (typeof obj["refresh_token"] !== "string" || !obj["refresh_token"]) {
    throw new Error(`Credentials file ${filePath} is missing "refresh_token"`);
  }

  return {
    client_id: obj["client_id"],
    client_secret: obj["client_secret"],
    refresh_token: obj["refresh_token"],
    ...(typeof obj["quota_project_id"] === "string" && obj["quota_project_id"]
      ? { quota_project_id: obj["quota_project_id"] }
      : {}),
  };
}

/**
 * Lists credential refs that have local JSON files in the credentials directory.
 * Returns an array of credentialRef strings (filenames without `.json` extension).
 */
export function listAvailableCredentialRefs(): string[] {
  const dir = credentialsDir();

  if (!fs.existsSync(dir)) {
    return [];
  }

  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
