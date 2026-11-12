/**
 * Display formatting. The UI is English only, so the locale is fixed and never taken from
 * the system: `12.4M`, `412k`, `$7.90`, `Nov 10`.
 */

import { daysInRange, weekStart } from '../../shared/period';
import { en } from '../i18n/en';

const LOCALE = 'en-US';
const PLACEHOLDER = '—';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimalFormat = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const costFormat = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const largeCostFormat = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** `1234567` → `1,234,567` */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  return integerFormat.format(value);
}

/**
 * Compact token count: `950`, `1.5k`, `412k`, `12.4M`, `1.2B`.
 * Millions and billions always keep one decimal; thousands keep one only below 10k.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs < 1_000) return sign + Math.round(abs).toString();
  if (abs < 9_950) {
    const thousands = Math.round(abs / 100) / 10;
    return `${sign}${Number.isInteger(thousands) ? thousands.toString() : thousands.toFixed(1)}k`;
  }
  if (abs < 999_500) return `${sign}${Math.round(abs / 1_000)}k`;
  if (abs < 999_950_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}${oneDecimalFormat.format(abs / 1_000_000_000)}B`;
}

/** Like `formatTokens` without a trailing `.0`, for axis labels: `50M`, `2.5M`. */
export function formatTokensAxis(value: number): string {
  return formatTokens(value).replace(/\.0(?=[MB]$)/, '');
}

/** Token count in thousands with a separator: `1080000` → `1,080k`. */
export function formatTokensK(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  return `${integerFormat.format(Math.round(value / 1_000))}k`;
}

/** Estimated cost in US dollars: `$7.90`, `$1,235`. Unknown cost (`null`) → `—`. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  if (value > 0 && value < 0.005) return '<$0.01';
  if (Math.abs(value) >= 999.995) return largeCostFormat.format(value);
  return costFormat.format(value);
}

interface PercentOptions {
  /** Prefix positive values with `+`, for changes between two periods. */
  signed?: boolean;
  /** Keep one decimal at any size (`96.8%`), for shares that must visibly add up. */
  precise?: boolean;
}

/** A ratio as a percentage: `0.46` → `46%`, `0.032` → `3.2%`. One decimal below 10%. */
export function formatPercent(ratio: number, options: PercentOptions = {}): string {
  if (!Number.isFinite(ratio)) return PLACEHOLDER;
  const percent = ratio * 100;
  const abs = Math.abs(percent);
  const rounded = abs < 9.95 || options.precise ? Math.round(abs * 10) / 10 : Math.round(abs);
  const digits = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
  const sign = rounded === 0 ? '' : percent < 0 ? '-' : options.signed ? '+' : '';
  return `${sign}${digits}%`;
}

interface DayOptions {
  /** Append the year: `Nov 10, 2026`. */
  year?: boolean;
  /** Start with the weekday: `Tue, Nov 10`. */
  weekday?: boolean;
}

/**
 * A local day `YYYY-MM-DD` as `Nov 10`. The string is read as is, without going through
 * `Date`, so the day can never shift with the time zone.
 */
export function formatDay(day: string, options: DayOptions = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return PLACEHOLDER;
  let label = `${month} ${Number(match[3])}`;
  if (options.year) label = `${label}, ${match[1]}`;
  if (options.weekday)
    label = `${en.dates.weekdays[daysInRange(weekStart(day), day) - 1]}, ${label}`;
  return label;
}

/** A month `YYYY-MM` as `Nov`, or `Nov 2026` with the year. */
export function formatMonth(month: string, options: { year?: boolean } = {}): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !name) return PLACEHOLDER;
  return options.year ? `${name} ${match[1]}` : name;
}

/**
 * A past local day relative to today: `Today`, `Yesterday`, `5 days ago`, then `Nov 10`
 * after a week, with the year once it is not this year's.
 */
export function formatRelativeDay(day: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return PLACEHOLDER;
  }
  const ago = daysInRange(day, today) - 1;
  if (ago === 0) return en.dates.today;
  if (ago === 1) return en.dates.yesterday;
  if (ago > 1 && ago < 7) return en.dates.daysAgo(ago);
  return formatDay(day, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

/** A duration in milliseconds: `36 s`, `4.1 min`, `38 min`, `1h 23m`. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return PLACEHOLDER;
  const seconds = milliseconds / 1_000;
  if (seconds < 59.5) return `${Math.round(seconds)} s`;

  const minutes = seconds / 60;
  if (minutes < 9.95) {
    const rounded = Math.round(minutes * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)} min`;
  }
  if (minutes < 59.5) return `${Math.round(minutes)} min`;

  const totalMinutes = Math.round(minutes);
  const hours = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
