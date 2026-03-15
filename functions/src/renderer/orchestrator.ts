import { DateTime } from "luxon";
import { KindleCalendarConfig } from "../config/types";
import { ProviderContext } from "../providers/provider.interface";
import { DateTimeProvider } from "../providers/datetime/datetime.provider";
import { DateTimeContext } from "../providers/datetime/types";
import { WeatherData } from "../providers/weather/types";
import { CalendarData } from "../providers/calendar/types";
import { renderTemplate, TemplateData } from "./template.engine";
import { renderHtmlToScreenshot } from "./puppeteer";
import { processForEink } from "./sharp.processor";

export interface RenderResult {
  html: string;
  png?: Buffer;
  jpg?: Buffer;
}

export interface OrchestratorOptions {
  /**
   * If true, only render HTML and skip Puppeteer + Sharp steps.
   * Useful for the /preview endpoint.
   */
  htmlOnly?: boolean;
}

/**
 * Custom provider interface used within the orchestrator to allow injecting
 * mock providers for development and testing.
 */
export interface ProviderSet {
  weather: { fetch(ctx: ProviderContext): Promise<WeatherData>; name: string };
  calendar: { fetch(ctx: ProviderContext): Promise<CalendarData>; name: string };
}

/**
 * Coordinates all rendering steps:
 * 1. Build provider context (config + now)
 * 2. Fetch datetime, weather, and calendar data concurrently
 * 3. Render the Nunjucks HTML template
 * 4. (Optional) Screenshot via Puppeteer
 * 5. (Optional) Process for e-ink via Sharp
 */
export class RenderOrchestrator {
  private readonly config: KindleCalendarConfig;
  private readonly providers: ProviderSet;
  private readonly datetimeProvider: DateTimeProvider;

  constructor(config: KindleCalendarConfig, providers: ProviderSet) {
    this.config = config;
    this.providers = providers;
    this.datetimeProvider = new DateTimeProvider();
  }

  async render(options: OrchestratorOptions = {}): Promise<RenderResult> {
    const now = DateTime.now().setZone(this.config.display.timezone);
    const context: ProviderContext = { config: this.config, now };

    // Fetch all data concurrently
    const [datetime, weather, calendar] = await Promise.all([
      this.datetimeProvider.fetch(context),
      this.fetchWeatherSafe(context),
      this.fetchCalendarSafe(context),
    ]);

    const templateData: TemplateData = {
      datetime: datetime as DateTimeContext,
      weather,
      calendar,
      config: this.config,
    };

    const html = renderTemplate(templateData);

    if (options.htmlOnly) {
      return { html };
    }

    // Screenshot via Puppeteer
    const { png: rawPng } = await renderHtmlToScreenshot(html, {
      width: this.config.display.width,
      height: this.config.display.height,
      dpi: this.config.display.dpi,
    });

    // Process for e-ink
    const { png, jpg } = await processForEink(rawPng, {
      grayscale: true,
      width: this.config.display.width,
      height: this.config.display.height,
    });

    return { html, png, jpg };
  }

  private async fetchWeatherSafe(context: ProviderContext): Promise<WeatherData> {
    try {
      return await this.providers.weather.fetch(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[RenderOrchestrator] Weather fetch failed: ${message}`);
      return {
        temperature: 0,
        temperatureHigh: 0,
        temperatureLow: 0,
        conditionCode: -1,
        conditionLabel: "Unavailable",
        conditionIcon: "?",
        windSpeed: 0,
        isAvailable: false,
      };
    }
  }

  private async fetchCalendarSafe(context: ProviderContext): Promise<CalendarData> {
    try {
      return await this.providers.calendar.fetch(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[RenderOrchestrator] Calendar fetch failed: ${message}`);
      return {
        allDayEvents: [],
        timedEvents: [],
        failedSources: [{ sourceId: "all", error: message }],
      };
    }
  }
}
