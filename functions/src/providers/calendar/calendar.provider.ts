import { DataProvider, ProviderContext } from "../provider.interface";
import { CalendarData, CalendarEvent } from "./types";
import { fetchGoogleCalendarEvents, GoogleCredentials } from "./google.source";
import { fetchIcsCalendarEvents } from "./ics.source";
import { mergeAndSortEvents } from "./merger";

/**
 * Map of credentialRef -> GoogleCredentials.
 * Populated by the dev server or Cloud Function entry point from local files
 * or Secret Manager, then passed into CalendarProvider at construction time.
 */
export type CredentialsMap = Map<string, GoogleCredentials>;

/**
 * Orchestrates all configured calendar sources.
 * Fetches events from each source concurrently, handles failures gracefully,
 * and merges + deduplicates the results.
 */
export class CalendarProvider implements DataProvider<CalendarData> {
  readonly name = "CalendarProvider";

  private readonly credentials: CredentialsMap;

  constructor(credentials: CredentialsMap = new Map()) {
    this.credentials = credentials;
  }

  async fetch(context: ProviderContext): Promise<CalendarData> {
    const { config } = context;
    const allEvents: CalendarEvent[] = [];
    const failedSources: { sourceId: string; error: string }[] = [];

    const results = await Promise.allSettled(
      config.calendars.map(async (source) => {
        let events: CalendarEvent[];

        if (source.type === "google") {
          const credRef = source.credentialRef;
          if (!credRef) {
            throw new Error(
              `Calendar source "${source.id}" has type "google" but no credentialRef configured.`
            );
          }
          const creds = this.credentials.get(credRef);
          if (!creds) {
            throw new Error(
              `No credentials found for credentialRef "${credRef}" (source: "${source.id}"). ` +
              `Run npx tsx scripts/oauth-setup.ts to obtain credentials.`
            );
          }
          events = await fetchGoogleCalendarEvents(source, context, creds);
        } else if (source.type === "ics") {
          events = await fetchIcsCalendarEvents(source, context);
        } else {
          throw new Error(
            `Unknown calendar source type: ${(source as { type: string }).type}`
          );
        }

        return { sourceId: source.id, events };
      })
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const source = config.calendars[i];

      if (result.status === "fulfilled") {
        allEvents.push(...result.value.events);
      } else {
        failedSources.push({
          sourceId: source.id,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }

    const { allDayEvents, timedEvents } = mergeAndSortEvents(allEvents, context.now);

    return { allDayEvents, timedEvents, failedSources };
  }
}
