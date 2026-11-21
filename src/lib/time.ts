import type { BusinessHours } from "../types";

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface LocalTime {
  readonly weekday: number;
  readonly minutes: number;
}

export function parseHHMM(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`invalid HH:MM: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Weekday and minutes-since-midnight of an instant in the given IANA timezone. */
export function localTime(date: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS[get("weekday")];
  if (weekday === undefined) throw new Error(`cannot resolve weekday for ${timezone}`);
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isWithinBusinessHours(date: Date, hours: BusinessHours): boolean {
  const { weekday, minutes } = localTime(date, hours.timezone);
  const start = parseHHMM(hours.start);
  const end = parseHHMM(hours.end);
  const dayListed = (d: number): boolean => hours.days.includes(d);

  if (start < end) return dayListed(weekday) && minutes >= start && minutes < end;
  // Window crosses midnight: starts on a listed day, ends on the following day.
  const previousDay = (weekday + 6) % 7;
  return (dayListed(weekday) && minutes >= start) || (dayListed(previousDay) && minutes < end);
}

/**
 * Nearest instant (searching forward, 15-minute steps, up to 8 days) that is outside business
 * hours. Used only by the after_hours demo simulation.
 */
export function nextOutsideBusinessHours(date: Date, hours: BusinessHours): Date {
  const step = 15 * 60 * 1000;
  for (let i = 0; i <= 8 * 24 * 4; i++) {
    const candidate = new Date(date.getTime() + i * step);
    if (!isWithinBusinessHours(candidate, hours)) return candidate;
  }
  throw new Error("business hours cover the whole week; no after-hours slot exists");
}

export function secondsBetween(fromIso: string, to: Date): number {
  return Math.floor((to.getTime() - Date.parse(fromIso)) / 1000);
}
