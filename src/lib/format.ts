/**
 * Display formatting in the current UI language, never the system's locale:
 * English `12.4M`, `412k`, `$7.90`, `Nov 10`; French `12,4 M`, `412 k`, `7,90 $`, `10 nov.`.
 * Words and word order come from the strings (`dates`); separators, unit symbols and their
 * spacing from `STYLES` below.
 */

import type { Language } from '../../shared/language';
import { daysInRange, weekStart } from '../../shared/period';
import { currentLanguage, LOCALES, strings } from '../i18n';

const PLACEHOLDER = '—';
/** French puts a narrow no-break space between a number and its unit: `12,4 M`, `46 %`. */
const NARROW_NBSP = '\u202f';

interface Style {
  /** Between a number and `k` / `M` / `B`: none in English, `12,4 M` in French. */
  compactGap: string;
  billion: string;
  /** Between a number and another unit: `36 s`, `4.2 MB`, `46 %`. */
  unitGap: string;
  percentGap: string;
  bytes: readonly [string, string, string, string, string];
  /** `$7.90` / `7,90 $`; `amount` has no sign. */
  cost: (amount: string, negative: boolean) => string;
  /** `1h 23m` / `1 h 23`. */
  hoursMinutes: (hours: number, minutes: number) => string;
  hours: (hours: number) => string;
}

const STYLES: Readonly<Record<Language, Style>> = {
  en: {
    compactGap: '',
    billion: 'B',
    unitGap: ' ',
    percentGap: '',
    bytes: ['B', 'KB', 'MB', 'GB', 'TB'],
    cost: (amount, negative) => `${negative ? '-' : ''}$${amount}`,
    hoursMinutes: (hours, minutes) => `${hours}h ${minutes}m`,
    hours: (hours) => `${hours}h`,
  },
  fr: {
    compactGap: NARROW_NBSP,
    billion: 'Md',
    unitGap: NARROW_NBSP,
    percentGap: NARROW_NBSP,
    bytes: ['o', 'Ko', 'Mo', 'Go', 'To'],
    cost: (amount, negative) => `${negative ? '-' : ''}${amount}\u00a0$`,
    hoursMinutes: (hours, minutes) =>
      `${hours}${NARROW_NBSP}h${NARROW_NBSP}${String(minutes).padStart(2, '0')}`,
    hours: (hours) => `${hours}${NARROW_NBSP}h`,
  },
};

interface NumberFormats {
  integer: Intl.NumberFormat;
  oneDecimal: Intl.NumberFormat;
  twoDecimals: Intl.NumberFormat;
}

const numberFormats = new Map<Language, NumberFormats>();

function formats(): NumberFormats {
  const language = currentLanguage();
  let cached = numberFormats.get(language);
  if (!cached) {
    const locale = LOCALES[language];
    cached = {
      integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      oneDecimal: new Intl.NumberFormat(locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
      twoDecimals: new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    };
    numberFormats.set(language, cached);
  }
  return cached;
}

const style = (): Style => STYLES[currentLanguage()];

/** `1.5` → `1,5` in French. For numbers written without a thousands separator. */
function localDecimal(text: string): string {
  return currentLanguage() === 'fr' ? text.replace('.', ',') : text;
}

/** `1.5` → `1.5` / `1,5`, `12` → `12`. For values below 1,000. */
function shortDecimal(value: number): string {
  return localDecimal(Number.isInteger(value) ? value.toString() : value.toFixed(1));
}

/** A price for an input field, all its digits kept: `3.75` / `3,75`. */
export function formatPriceInput(value: number): string {
  return localDecimal(String(value));
}

/** `1234567` → `1,234,567` / `1 234 567` */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  return formats().integer.format(value);
}

/** A small average with one decimal, without a trailing `.0`: `1.5`, `12`, `1,204.3`. */
export function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded)
    ? formats().integer.format(rounded)
    : formats().oneDecimal.format(rounded);
}

/**
 * Compact token count: `950`, `1.5k`, `412k`, `12.4M`, `1.2B`.
 * Millions and billions always keep one decimal; thousands keep one only below 10k.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  const { compactGap, billion } = style();
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs < 1_000) return sign + Math.round(abs).toString();
  if (abs < 9_950) return `${sign}${shortDecimal(Math.round(abs / 100) / 10)}${compactGap}k`;
  if (abs < 999_500) return `${sign}${Math.round(abs / 1_000)}${compactGap}k`;
  if (abs < 999_950_000) {
    return `${sign}${localDecimal((abs / 1_000_000).toFixed(1))}${compactGap}M`;
  }
  return `${sign}${formats().oneDecimal.format(abs / 1_000_000_000)}${compactGap}${billion}`;
}

/** Like `formatTokens` without a trailing `.0`, for axis labels: `50M`, `2.5M`. */
export function formatTokensAxis(value: number): string {
  return formatTokens(value).replace(/[.,]0(?=\D*$)/, '');
}

/** Token count in thousands with a separator: `1080000` → `1,080k` / `1 080 k`. */
export function formatTokensK(value: number): string {
  if (!Number.isFinite(value)) return PLACEHOLDER;
  return `${formats().integer.format(Math.round(value / 1_000))}${style().compactGap}k`;
}

/** Estimated cost in US dollars: `$7.90`, `$1,235`. Unknown cost (`null`) → `—`. */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  const { cost } = style();
  if (value > 0 && value < 0.005) return `<${cost(formats().twoDecimals.format(0.01), false)}`;
  const abs = Math.abs(value);
  const amount = abs >= 999.995 ? formats().integer.format(abs) : formats().twoDecimals.format(abs);
  // Rounding can turn a tiny negative value into zero: no sign then.
  return cost(amount, value < 0 && /[1-9]/.test(amount));
}

interface PercentOptions {
  /** Prefix positive values with `+`, for changes between two periods. */
  signed?: boolean;
  /** Keep one decimal at any size (`96.8%`), for shares that must visibly add up. */
  precise?: boolean;
  /** A positive ratio that would round to `0%` shows as `<0.1%`. */
  nonZero?: boolean;
}

/** A ratio as a percentage: `0.46` → `46%`, `0.032` → `3.2%`. One decimal below 10%. */
export function formatPercent(ratio: number, options: PercentOptions = {}): string {
  if (!Number.isFinite(ratio)) return PLACEHOLDER;
  if (options.nonZero && ratio > 0 && ratio < 0.0005) return `<${formatPercent(0.001)}`;
  const percent = ratio * 100;
  const abs = Math.abs(percent);
  const rounded = abs < 9.95 || options.precise ? Math.round(abs * 10) / 10 : Math.round(abs);
  const sign = rounded === 0 ? '' : percent < 0 ? '-' : options.signed ? '+' : '';
  return `${sign}${shortDecimal(rounded)}${style().percentGap}%`;
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
  const month = match ? strings.dates.months[Number(match[2]) - 1] : undefined;
  if (!match || !month) return PLACEHOLDER;
  const d = strings.dates;
  let label = d.day(Number(match[3]), month);
  if (options.year) label = d.dayWithYear(label, match[1]!);
  if (options.weekday) {
    label = d.withWeekday(d.weekdays[daysInRange(weekStart(day), day) - 1]!, label);
  }
  return label;
}

/**
 * A month `YYYY-MM` as `Nov`, or `Nov 2026` with the year. `narrow` gives the label of a
 * chart with one bar per month: the same in English, an initial in French.
 */
export function formatMonth(
  month: string,
  options: { year?: boolean; narrow?: boolean } = {},
): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const names = options.narrow ? strings.dates.monthsNarrow : strings.dates.months;
  const name = match ? names[Number(match[2]) - 1] : undefined;
  if (!match || !name) return PLACEHOLDER;
  return options.year ? strings.dates.monthWithYear(name, match[1]!) : name;
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
  if (ago === 0) return strings.dates.today;
  if (ago === 1) return strings.dates.yesterday;
  if (ago > 1 && ago < 7) return strings.dates.daysAgo(ago);
  return formatDay(day, { year: day.slice(0, 4) !== today.slice(0, 4) });
}

/** A duration in milliseconds: `36 s`, `4.1 min`, `38 min`, `1h 23m`. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return PLACEHOLDER;
  const { unitGap, hours, hoursMinutes } = style();
  const seconds = milliseconds / 1_000;
  if (seconds < 59.5) return `${Math.round(seconds)}${unitGap}s`;

  const minutes = seconds / 60;
  if (minutes < 9.95) return `${shortDecimal(Math.round(minutes * 10) / 10)}${unitGap}min`;
  if (minutes < 59.5) return `${Math.round(minutes)}${unitGap}min`;

  const totalMinutes = Math.round(minutes);
  const whole = Math.floor(totalMinutes / 60);
  const rest = totalMinutes % 60;
  return rest === 0 ? hours(whole) : hoursMinutes(whole, rest);
}

/** A file size: `812 B`, `4.2 MB`, `38 MB`, `1.3 GB` (1 KB = 1,024 bytes). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return PLACEHOLDER;
  const { unitGap, bytes: units } = style();
  if (bytes < 1024) return `${Math.round(bytes)}${unitGap}${units[0]}`;
  let value = bytes;
  let unit = 1;
  for (; unit < units.length; unit++) {
    value /= 1024;
    if (value < 1024) break;
  }
  unit = Math.min(unit, units.length - 1);
  const number = value < 10 ? formats().oneDecimal.format(value) : formats().integer.format(value);
  return `${number}${unitGap}${units[unit]}`;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

const localDayOf = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

/** An instant in this computer's time zone, with the year: `Nov 3, 2026, 14:05`. */
export function formatDateTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return PLACEHOLDER;
  const date = new Date(at);
  return strings.dates.dateTime(
    formatDay(localDayOf(date), { year: true }),
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
  );
}

/** How long ago an instant was: `just now`, `4 min ago`, `3 h ago`, then the day. */
export function formatTimeAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return PLACEHOLDER;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return strings.dates.justNow;
  if (minutes < 60) return strings.dates.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return strings.dates.hoursAgo(hours);
  return strings.dates.onDay(formatDay(localDayOf(new Date(at))));
}
