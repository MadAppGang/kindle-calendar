import * as nunjucks from "nunjucks";
import * as path from "path";
import * as fs from "fs";

export interface TemplateData {
  datetime: import("../providers/datetime/types").DateTimeContext;
  weather: import("../providers/weather/types").WeatherData;
  calendar: import("../providers/calendar/types").CalendarData;
  config: import("../config/types").KindleCalendarConfig;
}

let configuredEnv: nunjucks.Environment | null = null;

function resolveTemplatesDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "templates"),
    path.resolve(__dirname, "..", "..", "templates"),
    path.resolve(__dirname, "..", "..", "..", "templates"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `templates/ directory not found. Searched: ${candidates.join(", ")}`
  );
}

/**
 * Returns a configured Nunjucks environment pointing at the templates directory.
 * The environment is cached after first creation.
 */
export function getTemplateEngine(templatesDir?: string): nunjucks.Environment {
  if (configuredEnv) {
    return configuredEnv;
  }

  const dir = templatesDir ?? resolveTemplatesDir();
  const loader = new nunjucks.FileSystemLoader(dir, { noCache: process.env["NODE_ENV"] === "development" });
  const env = new nunjucks.Environment(loader, {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true,
  });

  // Add custom filters
  env.addFilter("timeHM", (isoString: string) => {
    try {
      const { DateTime } = require("luxon") as typeof import("luxon");
      return DateTime.fromISO(isoString).toFormat("HH:mm");
    } catch {
      return isoString;
    }
  });

  configuredEnv = env;
  return env;
}

/**
 * Renders the default template with the provided data.
 */
export function renderTemplate(data: TemplateData, template = "default/index.html"): string {
  const env = getTemplateEngine();
  return env.render(template, data as unknown as Record<string, unknown>);
}

/**
 * Clears the cached Nunjucks environment. Useful for testing.
 */
export function clearTemplateEngineCache(): void {
  configuredEnv = null;
}
