/**
 * Kindle Calendar Display — Firebase Cloud Functions entry point
 *
 * Exports:
 *   render  - Cloud Scheduler function: runs the full render pipeline on a schedule
 *   serve   - HTTPS function: serves /screen.png, /screen.jpg, /preview, /health
 */

export { renderScheduled as render } from "./handlers/render.handler";

import { onRequest } from "firebase-functions/v2/https";
import { loadConfig } from "./config/loader";
import { createServeRouter } from "./handlers/serve.handler";
import { WeatherProvider } from "./providers/weather/weather.provider";
import { CalendarProvider } from "./providers/calendar/calendar.provider";
import express, { Request, Response, NextFunction } from "express";

const app = express();

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[serve] ${req.method} ${req.url}`);
  next();
});

// Lazy-initialize providers so config load errors surface at request time
app.use((req: Request, res: Response, next: NextFunction) => {
  try {
    const config = loadConfig();
    const providers = {
      weather: new WeatherProvider(),
      calendar: new CalendarProvider(),
    };
    const router = createServeRouter({ config, providers });
    router(req, res, next);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[serve] Config load error:", message);
    res.status(500).json({ error: "Server configuration error", details: message });
  }
});

export const serve = onRequest(
  {
    region: "europe-west1",
    memory: "1GiB",
    timeoutSeconds: 60,
  },
  app
);
