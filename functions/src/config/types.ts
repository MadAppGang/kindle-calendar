export interface KindleCalendarConfig {
  display: {
    width: number;
    height: number;
    dpi: number;
    timezone: string;
  };
  location: {
    name: string;
    latitude: number;
    longitude: number;
  };
  calendars: CalendarSourceConfig[];
  weather: WeatherConfig;
  cache: {
    renderTTLSeconds: number;
    weatherTTLSeconds: number;
    calendarTTLSeconds: number;
  };
  server: {
    port: number;
    secret?: string;
  };
}

export interface CalendarSourceConfig {
  id: string;
  type: "google" | "ics";
  label: string;
  credentialRef?: string;
  serviceAccountRef?: string;
  calendarId?: string;
  icsUrl?: string;
  displayStyle: "solid" | "dashed" | "dotted";
}

export interface WeatherConfig {
  provider: "openmeteo" | "openweathermap";
  apiKeyRef?: string;
  units: "metric" | "imperial";
}
