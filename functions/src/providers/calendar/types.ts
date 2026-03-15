export interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  startFormatted: string;
  endFormatted: string;
  isAllDay: boolean;
  isInProgress: boolean;
  calendarId: string;
  sourceId: string;
  sourceLabel: string;
  displayStyle: "solid" | "dashed" | "dotted";
  attendeeCount?: number;
  location?: string;
}

export interface CalendarData {
  allDayEvents: CalendarEvent[];
  timedEvents: CalendarEvent[];
  failedSources: { sourceId: string; error: string }[];
}
