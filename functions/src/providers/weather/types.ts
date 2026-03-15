export interface WeatherData {
  temperature: number;
  temperatureHigh: number;
  temperatureLow: number;
  conditionCode: number;
  conditionLabel: string;
  conditionIcon: string;
  windSpeed: number;
  isAvailable: boolean;
}
