/**
 * Day arithmetic on local days written as `YYYY-MM-DD`. The strings are handled as plain
 * calendar dates, so nothing here depends on a time zone.
 */
import type { PeriodKey } from './types';

export const PERIOD_DAYS: Readonly<Record<PeriodKey, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function toEpochDay(day: string): number {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new RangeError(`Not a day: ${day}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

function fromEpochDay(epochDay: number): string {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

/** True for a real calendar day written as `YYYY-MM-DD`. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  return fromEpochDay(toEpochDay(value)) === value;
}

/** The day `count` days after `day` (before it when negative). */
export function addDays(day: string, count: number): string {
  return fromEpochDay(toEpochDay(day) + count);
}

/** Number of days from `from` to `to`, both included. */
export function daysInRange(from: string, to: string): number {
  return toEpochDay(to) - toEpochDay(from) + 1;
}

/** Every day from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const start = toEpochDay(from);
  const days: string[] = [];
  for (let offset = 0; offset < daysInRange(from, to); offset++) {
    days.push(fromEpochDay(start + offset));
  }
  return days;
}

/** The range covered by a period that ends today: `30d` is today and the 29 days before. */
export function periodRange(period: PeriodKey, today: string): { from: string; to: string } {
  return { from: addDays(today, 1 - PERIOD_DAYS[period]), to: today };
}

/** The range of the same length that ends just before `from`. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const length = daysInRange(from, to);
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

/** The local calendar day of a `Date`, as the system clock shows it. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
