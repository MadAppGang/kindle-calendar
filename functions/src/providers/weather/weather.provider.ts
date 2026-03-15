import * as https from "https";
import { DataProvider, ProviderContext } from "../provider.interface";
import { WeatherData } from "./types";

/**
 * WMO Weather interpretation codes → human-readable labels and icons.
 * https://open-meteo.com/en/docs#weathervariables
 */
const WMO_CODES: Record<number, { label: string; icon: string }> = {
  0: { label: "Clear", icon: "☀" },
  1: { label: "Mostly Clear", icon: "🌤" },
  2: { label: "Partly Cloudy", icon: "⛅" },
  3: { label: "Overcast", icon: "☁" },
  45: { label: "Foggy", icon: "🌫" },
  48: { label: "Rime Fog", icon: "🌫" },
  51: { label: "Light Drizzle", icon: "🌦" },
  53: { label: "Drizzle", icon: "🌦" },
  55: { label: "Heavy Drizzle", icon: "🌧" },
  61: { label: "Light Rain", icon: "🌧" },
  63: { label: "Rain", icon: "🌧" },
  65: { label: "Heavy Rain", icon: "🌧" },
  71: { label: "Light Snow", icon: "🌨" },
  73: { label: "Snow", icon: "🌨" },
  75: { label: "Heavy Snow", icon: "❄" },
  80: { label: "Rain Showers", icon: "🌦" },
  81: { label: "Mod. Showers", icon: "🌧" },
  82: { label: "Heavy Showers", icon: "🌧" },
  95: { label: "Thunderstorm", icon: "⛈" },
  96: { label: "T-Storm + Hail", icon: "⛈" },
  99: { label: "T-Storm + Hail", icon: "⛈" },
};

function lookupWMO(code: number): { label: string; icon: string } {
  return WMO_CODES[code] ?? { label: "Unknown", icon: "?" };
}

interface OpenMeteoResponse {
  current: {
    temperature_2m: number;
    weather_code: number;
    wind_speed_10m: number;
  };
  daily: {
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

function httpsGetJson(url: string, timeoutMs: number): Promise<OpenMeteoResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { Accept: "application/json" },
        family: 4, // Force IPv4 — avoids IPv6 timeout issues
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`Open-Meteo API returned ${res.statusCode}`));
          res.resume();
          return;
        }
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as OpenMeteoResponse);
          } catch {
            reject(new Error("Failed to parse Open-Meteo response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Open-Meteo request timed out"));
    });
  });
}

/**
 * OpenMeteo weather provider.
 * Fetches current conditions and daily high/low from the free Open-Meteo API.
 * No API key required.
 */
export class WeatherProvider implements DataProvider<WeatherData> {
  readonly name = "WeatherProvider";

  async fetch(context: ProviderContext): Promise<WeatherData> {
    const { latitude, longitude } = context.config.location;
    const timezone = context.config.display.timezone;

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
    url.searchParams.set("timezone", timezone);
    url.searchParams.set("forecast_days", "1");

    try {
      const data = await httpsGetJson(url.toString(), 5000);
      const wmo = lookupWMO(data.current.weather_code);

      return {
        temperature: Math.round(data.current.temperature_2m),
        temperatureHigh: Math.round(data.daily.temperature_2m_max[0] ?? 0),
        temperatureLow: Math.round(data.daily.temperature_2m_min[0] ?? 0),
        conditionCode: data.current.weather_code,
        conditionLabel: wmo.label,
        conditionIcon: wmo.icon,
        windSpeed: Math.round(data.current.wind_speed_10m),
        isAvailable: true,
      };
    } catch (err) {
      console.warn("[WeatherProvider]", err instanceof Error ? err.message : err);
      return {
        temperature: 0,
        temperatureHigh: 0,
        temperatureLow: 0,
        conditionCode: -1,
        conditionLabel: "Unavailable",
        conditionIcon: "—",
        windSpeed: 0,
        isAvailable: false,
      };
    }
  }
}
