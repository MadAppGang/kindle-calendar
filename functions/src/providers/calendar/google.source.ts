import { google } from "googleapis";
import { DateTime } from "luxon";
import { CalendarSourceConfig } from "../../config/types";
import { ProviderContext } from "../provider.interface";
import { CalendarEvent } from "./types";

export interface GoogleCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

/**
 * Google Calendar API adapter.
 * Fetches events for the current day from a Google Calendar using OAuth2 credentials.
 */
export async function fetchGoogleCalendarEvents(
  source: CalendarSourceConfig,
  context: ProviderContext,
  credentials: GoogleCredentials
): Promise<CalendarEvent[]> {
  const timezone = context.config.display.timezone;
  const now = context.now.setZone(timezone);

  const timeMin = now.startOf("day").toISO();
  const timeMax = now.endOf("day").toISO();

  if (!timeMin || !timeMax) {
    throw new Error(`[GoogleCalendarSource] Failed to compute time range for timezone ${timezone}`);
  }

  const auth = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret
  );
  auth.setCredentials({ refresh_token: credentials.refresh_token });

  const calendarOptions: { version: "v3"; auth: typeof auth; headers?: Record<string, string> } = {
    version: "v3",
    auth,
  };
  if (credentials.quota_project_id) {
    calendarOptions.headers = { "x-goog-user-project": credentials.quota_project_id };
  }
  const calendar = google.calendar(calendarOptions);

  const calendarId = source.calendarId ?? "primary";

  // Abort after 5 seconds
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  let response;
  try {
    response = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });
  } finally {
    clearTimeout(timeout);
  }

  const items = response.data.items ?? [];

  return items
    .filter((item) => item.status !== "cancelled")
    .map((item): CalendarEvent => {
      const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);

      let startIso: string;
      let endIso: string;
      let startFormatted: string;
      let endFormatted: string;

      if (isAllDay) {
        // All-day events use date strings like "2024-01-15"
        const startDate = item.start?.date ?? "";
        const endDate = item.end?.date ?? "";
        const startDt = DateTime.fromISO(startDate, { zone: timezone });
        const endDt = DateTime.fromISO(endDate, { zone: timezone });
        startIso = startDt.toISO() ?? startDate;
        endIso = endDt.toISO() ?? endDate;
        startFormatted = "";
        endFormatted = "";
      } else {
        const startRaw = item.start?.dateTime ?? "";
        const endRaw = item.end?.dateTime ?? "";
        const startDt = DateTime.fromISO(startRaw).setZone(timezone);
        const endDt = DateTime.fromISO(endRaw).setZone(timezone);
        startIso = startDt.toISO() ?? startRaw;
        endIso = endDt.toISO() ?? endRaw;
        startFormatted = startDt.toFormat("HH:mm");
        endFormatted = endDt.toFormat("HH:mm");
      }

      const nowMillis = context.now.toMillis();
      const startMillis = DateTime.fromISO(startIso).toMillis();
      const endMillis = DateTime.fromISO(endIso).toMillis();
      const isInProgress = !isAllDay && startMillis <= nowMillis && endMillis > nowMillis;

      return {
        id: item.id ?? `${source.id}-${startIso}`,
        title: item.summary ?? "(No title)",
        startTime: startIso,
        endTime: endIso,
        startFormatted,
        endFormatted,
        isAllDay,
        isInProgress,
        calendarId,
        sourceId: source.id,
        sourceLabel: source.label,
        displayStyle: source.displayStyle,
        attendeeCount: item.attendees?.length,
        location: item.location ?? undefined,
      };
    });
}
