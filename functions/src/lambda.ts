import express from "express";
import serverless from "serverless-http";
import * as path from "path";
import { loadConfig } from "./config/loader";
import { createServeRouter } from "./handlers/serve.handler";
import { CalendarProvider, CredentialsMap } from "./providers/calendar/calendar.provider";
import { WeatherProvider } from "./providers/weather/weather.provider";
import { GoogleCredentials } from "./providers/calendar/google.source";

const configPath = path.resolve(__dirname, "..", "config.yaml");
const config = loadConfig(configPath);

/**
 * In Lambda, credentials come from environment variables instead of local files.
 * Format: CALENDAR_CREDS_{ID}='{"client_id":"...","client_secret":"...","refresh_token":"...","quota_project_id":"..."}'
 */
function buildCredentialsMap(): CredentialsMap {
  const credentialsMap: CredentialsMap = new Map();

  for (const cal of config.calendars) {
    const ref = cal.credentialRef;
    if (!ref) continue;

    const envKey = `CALENDAR_CREDS_${ref.toUpperCase()}`;
    const raw = process.env[envKey];
    if (!raw) {
      console.warn(`[lambda] Missing env var ${envKey} for calendar "${cal.id}"`);
      continue;
    }

    if (credentialsMap.has(ref)) continue;

    try {
      const creds = JSON.parse(raw) as GoogleCredentials;
      credentialsMap.set(ref, creds);
    } catch {
      console.error(`[lambda] Failed to parse ${envKey}`);
    }
  }

  return credentialsMap;
}

const credentialsMap = buildCredentialsMap();

const providers = {
  weather: new WeatherProvider(),
  calendar: new CalendarProvider(credentialsMap),
};

const app = express();

app.use((req, _res, next) => {
  console.log(`[lambda] ${req.method} ${req.url}`);
  next();
});

const router = createServeRouter({ config, providers });
app.use("/", router);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export const handler = serverless(app, {
  binary: ["image/png", "image/jpeg", "image/*"],
});
