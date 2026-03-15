import { DateTime } from "luxon";
import { KindleCalendarConfig } from "../config/types";

export interface DataProvider<T> {
  readonly name: string;
  fetch(context: ProviderContext): Promise<T>;
}

export interface ProviderContext {
  config: KindleCalendarConfig;
  now: DateTime;
}
