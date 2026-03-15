import { onSchedule } from "firebase-functions/v2/scheduler";
import { loadConfig } from "../config/loader";
import { RenderOrchestrator } from "../renderer/orchestrator";
import { WeatherProvider } from "../providers/weather/weather.provider";
import { CalendarProvider } from "../providers/calendar/calendar.provider";

/**
 * Cloud Scheduler-triggered function that runs the full render pipeline.
 * Fetches data, renders the template, screenshots, processes, and uploads to GCS.
 *
 * Schedule: every 5 minutes during waking hours.
 */
export const renderScheduled = onSchedule(
  {
    schedule: "*/5 6-23 * * *",
    timeZone: "Europe/Madrid",
    region: "europe-west1",
  },
  async (_event) => {
    const config = loadConfig();
    const providers = {
      weather: new WeatherProvider(),
      calendar: new CalendarProvider(),
    };
    const orchestrator = new RenderOrchestrator(config, providers);
    const result = await orchestrator.render();

    if (!result.png || !result.jpg) {
      throw new Error("Render pipeline did not produce image output");
    }

    // TODO: upload to GCS using gcs.uploader.ts
    console.log("[render.handler] Render complete, PNG size:", result.png.length);
  }
);
