import express from "express";
import serverless from "serverless-http";
import * as path from "path";
import { loadConfig } from "./config/loader";
import { createServeRouter } from "./handlers/serve.handler";
import { CalendarProvider, CredentialsMap } from "./providers/calendar/calendar.provider";
import { WeatherProvider } from "./providers/weather/weather.provider";
import { GoogleCredentials } from "./providers/calendar/google.source";
import { RenderOrchestrator } from "./renderer/orchestrator";
import { uploadToS3 } from "./storage/s3.uploader";

const S3_BUCKET = process.env["DISPLAY_BUCKET"] || "kindle-calendar-display";

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

// ── HTTP handler (API Gateway) ──
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

const httpHandler = serverless(app, {
  binary: ["image/png", "image/jpeg", "image/*"],
});

// ── Scheduled handler (EventBridge) ──
async function scheduledRender(): Promise<void> {
  console.log("[lambda] Scheduled render started");

  const orchestrator = new RenderOrchestrator(config, providers);
  const result = await orchestrator.render();

  if (!result.png || !result.jpg) {
    throw new Error("Render pipeline did not produce image output");
  }

  const [pngUrl, jpgUrl] = await Promise.all([
    uploadToS3(result.png, {
      bucket: S3_BUCKET,
      key: "screen.png",
      contentType: "image/png",
    }),
    uploadToS3(result.jpg, {
      bucket: S3_BUCKET,
      key: "screen.jpg",
      contentType: "image/jpeg",
    }),
  ]);

  console.log(`[lambda] Scheduled render complete — PNG: ${pngUrl}, JPG: ${jpgUrl}`);
}

// ── Dispatcher ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any, context: any) => {
  if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
    await scheduledRender();
    return { statusCode: 200, body: "ok" };
  }

  // HTTP request via API Gateway
  return httpHandler(event, context);
};
