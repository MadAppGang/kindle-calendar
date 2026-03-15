import express from "express";
import * as path from "path";
import { loadConfig } from "../config/loader";
import { createServeRouter } from "../handlers/serve.handler";
import { MockCalendarProvider } from "./mock.providers";
import { WeatherProvider } from "../providers/weather/weather.provider";
import { CalendarProvider, CredentialsMap } from "../providers/calendar/calendar.provider";
import { loadCredentials, listAvailableCredentialRefs } from "../secrets/credential.loader";

// Point config loader at functions/ root
const configPath = path.resolve(__dirname, "..", "..", "config.yaml");

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[dev/server] Failed to load config: ${msg}`);
  console.error("[dev/server] Copy functions/config.example.yaml to functions/config.yaml and edit it.");
  process.exit(1);
}

const app = express();

// Log all requests
app.use((req, _res, next) => {
  console.log(`[dev/server] ${req.method} ${req.url}`);
  next();
});

// Determine which calendar provider to use based on available credentials
function buildCalendarProvider() {
  const availableRefs = listAvailableCredentialRefs();

  if (availableRefs.length === 0) {
    console.log("[dev/server] No credential files found in credentials/. Using MockCalendarProvider.");
    console.log("[dev/server] Run `npx tsx scripts/oauth-setup.ts` to set up real Google Calendar access.");
    return new MockCalendarProvider();
  }

  // Build credentials map for all available refs
  const credentialsMap: CredentialsMap = new Map();
  const loaded: string[] = [];
  const failed: string[] = [];

  for (const ref of availableRefs) {
    try {
      const creds = loadCredentials(ref);
      credentialsMap.set(ref, creds);
      loaded.push(ref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[dev/server] Failed to load credentials for "${ref}": ${msg}`);
      failed.push(ref);
    }
  }

  if (credentialsMap.size === 0) {
    console.warn("[dev/server] All credential files failed to load. Falling back to MockCalendarProvider.");
    return new MockCalendarProvider();
  }

  console.log(`[dev/server] Loaded ${credentialsMap.size} credential set(s): ${loaded.join(", ")}`);
  if (failed.length > 0) {
    console.warn(`[dev/server] Failed to load: ${failed.join(", ")}`);
  }
  console.log("[dev/server] Using real CalendarProvider with Google Calendar API.");

  return new CalendarProvider(credentialsMap);
}

const calendarProvider = buildCalendarProvider();

const providers = {
  weather: new WeatherProvider(),
  calendar: calendarProvider,
};

const router = createServeRouter({ config, providers });
app.use("/", router);

// Fallback 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const port = config.server.port ?? 8080;

app.listen(port, () => {
  console.log(`[dev/server] Kindle Calendar dev server running at http://localhost:${port}`);
  console.log(`[dev/server] Endpoints:`);
  console.log(`[dev/server]   GET http://localhost:${port}/preview   — HTML preview`);
  console.log(`[dev/server]   GET http://localhost:${port}/screen.png — PNG (requires Puppeteer)`);
  console.log(`[dev/server]   GET http://localhost:${port}/screen.jpg — JPG (requires Puppeteer)`);
  console.log(`[dev/server]   GET http://localhost:${port}/health     — Health check`);
});
