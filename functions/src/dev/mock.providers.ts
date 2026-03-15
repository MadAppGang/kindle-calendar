import { ProviderContext } from "../providers/provider.interface";
import { CalendarData, CalendarEvent } from "../providers/calendar/types";
import { WeatherData } from "../providers/weather/types";
import { DateTime } from "luxon";

const TIMEZONE = "Europe/Madrid";

/**
 * Builds a CalendarEvent relative to "now" in the configured timezone.
 */
function makeTimedEvent(
  id: string,
  title: string,
  startHour: number,
  startMinute: number,
  durationMinutes: number,
  sourceId: string,
  sourceLabel: string,
  displayStyle: "solid" | "dashed" | "dotted",
  now: DateTime,
  extra: Partial<CalendarEvent> = {}
): CalendarEvent {
  const tz = now.zoneName ?? TIMEZONE;
  const start = now.startOf("day").set({ hour: startHour, minute: startMinute }).setZone(tz);
  const end = start.plus({ minutes: durationMinutes });

  const nowTs = now.toMillis();
  const isInProgress = start.toMillis() <= nowTs && end.toMillis() > nowTs;

  return {
    id,
    title,
    startTime: start.toISO() ?? start.toString(),
    endTime: end.toISO() ?? end.toString(),
    startFormatted: start.toFormat("HH:mm"),
    endFormatted: end.toFormat("HH:mm"),
    isAllDay: false,
    isInProgress,
    calendarId: sourceId,
    sourceId,
    sourceLabel,
    displayStyle,
    ...extra,
  };
}

function makeAllDayEvent(
  id: string,
  title: string,
  sourceId: string,
  sourceLabel: string,
  displayStyle: "solid" | "dashed" | "dotted",
  now: DateTime,
  extra: Partial<CalendarEvent> = {}
): CalendarEvent {
  const tz = now.zoneName ?? TIMEZONE;
  const start = now.startOf("day").setZone(tz);
  const end = start.endOf("day");

  return {
    id,
    title,
    startTime: start.toISO() ?? start.toString(),
    endTime: end.toISO() ?? end.toString(),
    startFormatted: "",
    endFormatted: "",
    isAllDay: true,
    isInProgress: false,
    calendarId: sourceId,
    sourceId,
    sourceLabel,
    displayStyle,
    ...extra,
  };
}

/**
 * Mock CalendarProvider — returns realistic fake events for a day in Valencia.
 */
export class MockCalendarProvider {
  readonly name = "MockCalendarProvider";

  async fetch(context: ProviderContext): Promise<CalendarData> {
    const now = context.now.setZone(TIMEZONE);

    const allDayEvents: CalendarEvent[] = [
      makeAllDayEvent(
        "allday-1",
        "Team Offsice — Barcelona",
        "personal",
        "Personal",
        "solid",
        now
      ),
    ];

    const timedEvents: CalendarEvent[] = [
      makeTimedEvent(
        "ev-standup",
        "Daily Standup",
        9, 0, 15,
        "work",
        "Work",
        "dashed",
        now,
        { attendeeCount: 6 }
      ),
      makeTimedEvent(
        "ev-gym",
        "Gym — Crossfit",
        10, 0, 60,
        "personal",
        "Personal",
        "solid",
        now
      ),
      makeTimedEvent(
        "ev-design-review",
        "Design Review: Onboarding Flow",
        11, 30, 60,
        "work",
        "Work",
        "dashed",
        now,
        { attendeeCount: 4, location: "Google Meet" }
      ),
      makeTimedEvent(
        "ev-lunch",
        "Lunch with Maria",
        13, 30, 90,
        "personal",
        "Personal",
        "solid",
        now,
        { location: "Restaurante La Pepica" }
      ),
      makeTimedEvent(
        "ev-sprint-planning",
        "Sprint Planning Q1 Week 11",
        15, 0, 120,
        "work",
        "Work",
        "dashed",
        now,
        { attendeeCount: 8, location: "Zoom" }
      ),
      makeTimedEvent(
        "ev-dentist",
        "Dentist Appointment",
        17, 0, 45,
        "personal",
        "Personal",
        "solid",
        now,
        { location: "Clínica Dental Centro" }
      ),
      makeTimedEvent(
        "ev-yoga",
        "Yoga — Evening Flow",
        19, 30, 60,
        "personal",
        "Personal",
        "dotted",
        now
      ),
    ].sort((a, b) => a.startTime.localeCompare(b.startTime));

    return {
      allDayEvents,
      timedEvents,
      failedSources: [],
    };
  }
}

/**
 * Mock WeatherProvider — returns realistic weather for Valencia in spring.
 */
export class MockWeatherProvider {
  readonly name = "MockWeatherProvider";

  async fetch(_context: ProviderContext): Promise<WeatherData> {
    return {
      temperature: 18,
      temperatureHigh: 22,
      temperatureLow: 12,
      conditionCode: 1,
      conditionLabel: "Partly Cloudy",
      conditionIcon: "⛅",
      windSpeed: 14,
      isAvailable: true,
    };
  }
}
