import { DateTime } from "luxon";
import { CalendarEvent } from "./types";

/**
 * Normalizes a title for deduplication: lowercase, collapse whitespace, strip punctuation.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a composite deduplication key from normalized title + startTime + endTime.
 * Two events from different calendars with the same title and time window are treated as duplicates.
 */
function dedupeKey(event: CalendarEvent): string {
  return `${normalizeTitle(event.title)}|${event.startTime}|${event.endTime}`;
}

/**
 * Merges events from multiple sources, deduplicates by composite key
 * (normalized title + startTime + endTime), annotates isInProgress based on
 * current time, and sorts chronologically.
 *
 * Timed events are sorted by startTime ascending.
 * All-day events are sorted alphabetically by title.
 */
export function mergeAndSortEvents(
  allEvents: CalendarEvent[],
  now?: DateTime
): { allDayEvents: CalendarEvent[]; timedEvents: CalendarEvent[] } {
  const nowMillis = now ? now.toMillis() : DateTime.now().toMillis();

  // Deduplicate: prefer first occurrence for each composite key
  const seenKeys = new Set<string>();
  const deduped: CalendarEvent[] = [];

  for (const event of allEvents) {
    const key = dedupeKey(event);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduped.push(event);
    }
  }

  // Annotate isInProgress based on current time
  const annotated = deduped.map((event): CalendarEvent => {
    if (event.isAllDay) {
      return { ...event, isInProgress: false };
    }
    const startMillis = DateTime.fromISO(event.startTime).toMillis();
    const endMillis = DateTime.fromISO(event.endTime).toMillis();
    const isInProgress = startMillis <= nowMillis && endMillis > nowMillis;
    return { ...event, isInProgress };
  });

  const allDayEvents = annotated
    .filter((e) => e.isAllDay)
    .sort((a, b) => a.title.localeCompare(b.title));

  const timedEvents = annotated
    .filter((e) => !e.isAllDay)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  return { allDayEvents, timedEvents };
}
