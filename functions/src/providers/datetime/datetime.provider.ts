import { DataProvider, ProviderContext } from "../provider.interface";
import { DateTimeContext } from "./types";

/**
 * Timezone-aware date/time provider.
 * Converts the current moment into all the display-ready strings the template needs.
 */
export class DateTimeProvider implements DataProvider<DateTimeContext> {
  readonly name = "DateTimeProvider";

  async fetch(context: ProviderContext): Promise<DateTimeContext> {
    const { config, now } = context;
    const tz = config.display.timezone;

    // Ensure we're working in the configured timezone
    const local = now.setZone(tz);

    const startOfDay = local.startOf("day");
    const endOfDay = local.endOf("day");

    return {
      iso: local.toISO() ?? local.toString(),
      date: local.toFormat("cccc, d MMMM yyyy"),
      time: local.toFormat("HH:mm"),
      dayOfWeek: local.toFormat("cccc"),
      dayOfMonth: local.day,
      month: local.toFormat("MMMM"),
      year: local.year,
      timezone: tz,
      startOfDay: startOfDay.toISO() ?? startOfDay.toString(),
      endOfDay: endOfDay.toISO() ?? endOfDay.toString(),
    };
  }
}
