import { CalendarSourceConfig } from "../../config/types";
import { ProviderContext } from "../provider.interface";
import { CalendarEvent } from "./types";

/**
 * ICS/iCal URL adapter.
 * Fetches and parses an ICS feed from a remote URL.
 *
 * @stub - Not yet implemented. Will use node-ical to parse the feed.
 */
export async function fetchIcsCalendarEvents(
  _source: CalendarSourceConfig,
  _context: ProviderContext
): Promise<CalendarEvent[]> {
  throw new Error(
    "ICS calendar source not yet implemented. " +
    "Provide an icsUrl in your calendar source config and implement this adapter."
  );
}
