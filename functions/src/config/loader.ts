import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { KindleCalendarConfig, CalendarSourceConfig, WeatherConfig } from "./types";

const CONFIG_FILENAME = "config.yaml";

function findConfigPath(): string {
  // Look for config.yaml relative to the functions/ root
  const candidates = [
    path.resolve(process.cwd(), CONFIG_FILENAME),
    path.resolve(__dirname, "..", "..", CONFIG_FILENAME),
    path.resolve(__dirname, "..", "..", "..", CONFIG_FILENAME),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `config.yaml not found. Searched: ${candidates.join(", ")}. ` +
    "Copy config.example.yaml to config.yaml and fill in your values."
  );
}

function validateCalendarSource(source: unknown, index: number): CalendarSourceConfig {
  if (typeof source !== "object" || source === null) {
    throw new Error(`calendars[${index}] must be an object`);
  }

  const s = source as Record<string, unknown>;

  if (typeof s["id"] !== "string" || !s["id"]) {
    throw new Error(`calendars[${index}].id must be a non-empty string`);
  }
  if (s["type"] !== "google" && s["type"] !== "ics") {
    throw new Error(`calendars[${index}].type must be "google" or "ics"`);
  }
  if (typeof s["label"] !== "string" || !s["label"]) {
    throw new Error(`calendars[${index}].label must be a non-empty string`);
  }
  const validStyles = ["solid", "dashed", "dotted"];
  if (!validStyles.includes(s["displayStyle"] as string)) {
    throw new Error(`calendars[${index}].displayStyle must be one of: ${validStyles.join(", ")}`);
  }

  return {
    id: s["id"] as string,
    type: s["type"] as "google" | "ics",
    label: s["label"] as string,
    credentialRef: s["credentialRef"] as string | undefined,
    serviceAccountRef: s["serviceAccountRef"] as string | undefined,
    calendarId: s["calendarId"] as string | undefined,
    icsUrl: s["icsUrl"] as string | undefined,
    displayStyle: s["displayStyle"] as "solid" | "dashed" | "dotted",
  };
}

function validateWeather(weather: unknown): WeatherConfig {
  if (typeof weather !== "object" || weather === null) {
    throw new Error("weather must be an object");
  }

  const w = weather as Record<string, unknown>;

  if (w["provider"] !== "openmeteo" && w["provider"] !== "openweathermap") {
    throw new Error('weather.provider must be "openmeteo" or "openweathermap"');
  }
  if (w["units"] !== "metric" && w["units"] !== "imperial") {
    throw new Error('weather.units must be "metric" or "imperial"');
  }

  return {
    provider: w["provider"] as "openmeteo" | "openweathermap",
    apiKeyRef: w["apiKeyRef"] as string | undefined,
    units: w["units"] as "metric" | "imperial",
  };
}

function validate(raw: unknown): KindleCalendarConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config.yaml must contain a YAML object");
  }

  const r = raw as Record<string, unknown>;

  // Validate display
  if (typeof r["display"] !== "object" || r["display"] === null) {
    throw new Error("display must be an object");
  }
  const display = r["display"] as Record<string, unknown>;
  if (typeof display["width"] !== "number") throw new Error("display.width must be a number");
  if (typeof display["height"] !== "number") throw new Error("display.height must be a number");
  if (typeof display["dpi"] !== "number") throw new Error("display.dpi must be a number");
  if (typeof display["timezone"] !== "string" || !display["timezone"]) {
    throw new Error("display.timezone must be a non-empty string");
  }

  // Validate location
  if (typeof r["location"] !== "object" || r["location"] === null) {
    throw new Error("location must be an object");
  }
  const location = r["location"] as Record<string, unknown>;
  if (typeof location["name"] !== "string" || !location["name"]) {
    throw new Error("location.name must be a non-empty string");
  }
  if (typeof location["latitude"] !== "number") throw new Error("location.latitude must be a number");
  if (typeof location["longitude"] !== "number") throw new Error("location.longitude must be a number");

  // Validate calendars
  if (!Array.isArray(r["calendars"])) {
    throw new Error("calendars must be an array");
  }
  const calendars = r["calendars"].map((s, i) => validateCalendarSource(s, i));

  // Validate weather
  const weather = validateWeather(r["weather"]);

  // Validate cache
  if (typeof r["cache"] !== "object" || r["cache"] === null) {
    throw new Error("cache must be an object");
  }
  const cache = r["cache"] as Record<string, unknown>;
  if (typeof cache["renderTTLSeconds"] !== "number") throw new Error("cache.renderTTLSeconds must be a number");
  if (typeof cache["weatherTTLSeconds"] !== "number") throw new Error("cache.weatherTTLSeconds must be a number");
  if (typeof cache["calendarTTLSeconds"] !== "number") throw new Error("cache.calendarTTLSeconds must be a number");

  // Validate server
  if (typeof r["server"] !== "object" || r["server"] === null) {
    throw new Error("server must be an object");
  }
  const server = r["server"] as Record<string, unknown>;
  if (typeof server["port"] !== "number") throw new Error("server.port must be a number");

  return {
    display: {
      width: display["width"] as number,
      height: display["height"] as number,
      dpi: display["dpi"] as number,
      timezone: display["timezone"] as string,
    },
    location: {
      name: location["name"] as string,
      latitude: location["latitude"] as number,
      longitude: location["longitude"] as number,
    },
    calendars,
    weather,
    cache: {
      renderTTLSeconds: cache["renderTTLSeconds"] as number,
      weatherTTLSeconds: cache["weatherTTLSeconds"] as number,
      calendarTTLSeconds: cache["calendarTTLSeconds"] as number,
    },
    server: {
      port: server["port"] as number,
      secret: server["secret"] as string | undefined,
    },
  };
}

let cachedConfig: KindleCalendarConfig | null = null;

/**
 * Loads and validates config.yaml. Result is cached after first load.
 */
export function loadConfig(configPath?: string): KindleCalendarConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const resolvedPath = configPath ?? findConfigPath();
  const raw = fs.readFileSync(resolvedPath, "utf8");
  const parsed = yaml.load(raw);
  const config = validate(parsed);

  cachedConfig = config;
  return config;
}

/**
 * Clears the cached config. Useful for testing.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
