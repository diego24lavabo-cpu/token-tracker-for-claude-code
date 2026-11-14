import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n';
import {
  formatBytes,
  formatCost,
  formatDecimal,
  formatPriceInput,
  formatTimeAgo,
  formatDateTime,
  formatDay,
  formatMonth,
  formatDuration,
  formatInt,
  formatPercent,
  formatRelativeDay,
  formatTokens,
  formatTokensAxis,
  formatTokensK,
} from '../src/lib/format';

describe('formatInt', () => {
  it('groups thousands the English way', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(1234567)).toBe('1,234,567');
  });

  it('shows a dash for values that are not numbers', () => {
    expect(formatInt(Number.NaN)).toBe('—');
  });
});

describe('formatTokens', () => {
  it('shows small counts as they are', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(999)).toBe('999');
  });

  it('keeps one decimal below 10k and none above', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(1540)).toBe('1.5k');
    expect(formatTokens(8000)).toBe('8k');
    expect(formatTokens(9960)).toBe('10k');
    expect(formatTokens(412_300)).toBe('412k');
  });

  it('switches to millions instead of showing 1000k', () => {
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_500)).toBe('1.0M');
    expect(formatTokens(1_700_000)).toBe('1.7M');
    expect(formatTokens(12_440_000)).toBe('12.4M');
    expect(formatTokens(9_000_000)).toBe('9.0M');
  });

  it('switches to billions instead of showing 1000M', () => {
    expect(formatTokens(999_960_000)).toBe('1.0B');
    expect(formatTokens(1_240_000_000)).toBe('1.2B');
  });

  it('shows a dash for values that are not numbers', () => {
    expect(formatTokens(Number.NaN)).toBe('—');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatTokensAxis', () => {
  it('drops a trailing .0 and keeps real decimals', () => {
    expect(formatTokensAxis(100_000_000)).toBe('100M');
    expect(formatTokensAxis(50_000_000)).toBe('50M');
    expect(formatTokensAxis(2_500_000)).toBe('2.5M');
    expect(formatTokensAxis(875_000)).toBe('875k');
    expect(formatTokensAxis(0)).toBe('0');
  });
});

describe('formatTokensK', () => {
  it('expresses the count in thousands with a separator', () => {
    expect(formatTokensK(1_080_000)).toBe('1,080k');
    expect(formatTokensK(875_000)).toBe('875k');
    expect(formatTokensK(0)).toBe('0k');
  });
});

describe('formatCost', () => {
  it('formats dollars with two decimals', () => {
    expect(formatCost(7.9)).toBe('$7.90');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(85)).toBe('$85.00');
  });

  it('drops the decimals for large amounts', () => {
    expect(formatCost(1234.5)).toBe('$1,235');
  });

  it('does not round a tiny cost down to zero', () => {
    expect(formatCost(0.001)).toBe('<$0.01');
  });

  it('shows a dash when the cost is unknown', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('keeps one decimal below 10%', () => {
    expect(formatPercent(0.032)).toBe('3.2%');
    expect(formatPercent(0.03)).toBe('3%');
    expect(formatPercent(0.46)).toBe('46%');
    expect(formatPercent(0.968)).toBe('97%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('keeps one decimal on request, so two shares visibly add up', () => {
    expect(formatPercent(0.968, { precise: true })).toBe('96.8%');
    expect(formatPercent(0.032, { precise: true })).toBe('3.2%');
    expect(formatPercent(1, { precise: true })).toBe('100%');
  });

  it('adds a sign for changes between periods', () => {
    expect(formatPercent(0.18, { signed: true })).toBe('+18%');
    expect(formatPercent(-0.052, { signed: true })).toBe('-5.2%');
    expect(formatPercent(0, { signed: true })).toBe('0%');
  });

  it('never shows 0% for a share that is not zero, on request', () => {
    expect(formatPercent(0.0002, { nonZero: true })).toBe('<0.1%');
    expect(formatPercent(0.0002)).toBe('0%');
    expect(formatPercent(0, { nonZero: true })).toBe('0%');
    expect(formatPercent(0.0006, { nonZero: true })).toBe('0.1%');
  });

  it('shows a dash when there is nothing to compare with', () => {
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('formatDay', () => {
  it('formats a local day in English', () => {
    expect(formatDay('2026-11-10')).toBe('Nov 10');
    expect(formatDay('2026-01-01')).toBe('Jan 1');
    expect(formatDay('2026-11-09', { year: true })).toBe('Nov 9, 2026');
    expect(formatDay('2026-11-08', { weekday: true })).toBe('Sun, Nov 8');
    expect(formatDay('2026-11-09', { weekday: true, year: true })).toBe('Mon, Nov 9, 2026');
  });

  it('shows a dash for anything that is not a day', () => {
    expect(formatDay('')).toBe('—');
    expect(formatDay('2026-13-01')).toBe('—');
    expect(formatDay('2026-11-10T12:00:00Z')).toBe('—');
  });
});

describe('formatMonth', () => {
  it('writes a month as its short name', () => {
    expect(formatMonth('2026-11')).toBe('Nov');
    expect(formatMonth('2025-12', { year: true })).toBe('Dec 2025');
    expect(formatMonth('2026-06', { narrow: true })).toBe('Jun');
    expect(formatMonth('2026-13')).toBe('—');
    expect(formatMonth('2026-11-10')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(36_000)).toBe('36 s');
    expect(formatDuration(4.1 * 60_000)).toBe('4.1 min');
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(38 * 60_000)).toBe('38 min');
    expect(formatDuration(83 * 60_000)).toBe('1h 23m');
    expect(formatDuration(120 * 60_000)).toBe('2h');
  });

  it('never shows 60 s or 60 min', () => {
    expect(formatDuration(59_700)).toBe('1 min');
    expect(formatDuration(59.8 * 60_000)).toBe('1h');
  });

  it('shows a dash for invalid durations', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatRelativeDay', () => {
  it('names the last few days relative to today', () => {
    expect(formatRelativeDay('2026-11-10', '2026-11-10')).toBe('Today');
    expect(formatRelativeDay('2026-11-09', '2026-11-10')).toBe('Yesterday');
    expect(formatRelativeDay('2026-11-04', '2026-11-10')).toBe('6 days ago');
  });

  it('shows older days as dates, with the year when it differs', () => {
    expect(formatRelativeDay('2026-11-03', '2026-11-10')).toBe('Nov 3');
    expect(formatRelativeDay('2025-12-30', '2026-01-02')).toBe('3 days ago');
    expect(formatRelativeDay('2025-12-20', '2026-01-02')).toBe('Dec 20, 2025');
  });

  it('shows a dash for a value that is not a day', () => {
    expect(formatRelativeDay('', '2026-11-10')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('shows a local instant with the year and a 24-hour clock', () => {
    // Built from local fields, so the test holds in any time zone.
    expect(formatDateTime(new Date(2026, 10, 3, 14, 5).toISOString())).toBe('Nov 3, 2026, 14:05');
    expect(formatDateTime(new Date(2025, 0, 9, 0, 7).toISOString())).toBe('Jan 9, 2025, 00:07');
  });

  it('shows a dash for a value that is not a date', () => {
    expect(formatDateTime('soon')).toBe('—');
  });
});

describe('in French', () => {
  // A narrow no-break space between a number and its unit, a no-break space before `$`.
  const n = '\u202f';
  beforeEach(() => setLanguage('fr'));
  afterEach(() => setLanguage('en'));

  it('writes numbers with a decimal comma and spaced units', () => {
    expect(formatInt(1234567)).toBe(`1${n}234${n}567`);
    expect(formatDecimal(1.5)).toBe('1,5');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1540)).toBe(`1,5${n}k`);
    expect(formatTokens(412_300)).toBe(`412${n}k`);
    expect(formatTokens(12_400_000)).toBe(`12,4${n}M`);
    expect(formatTokens(1_234_000_000)).toBe(`1,2${n}Md`);
    expect(formatTokensAxis(50_000_000)).toBe(`50${n}M`);
    expect(formatTokensAxis(2_500_000)).toBe(`2,5${n}M`);
    expect(formatTokensK(1_080_000)).toBe(`1${n}080${n}k`);
  });

  it('puts the dollar sign after the amount', () => {
    expect(formatCost(7.9)).toBe('7,90\u00a0$');
    expect(formatCost(1234.5)).toBe(`1${n}235\u00a0$`);
    expect(formatCost(0.001)).toBe('<0,01\u00a0$');
    expect(formatCost(null)).toBe('—');
  });

  it('spaces the percent sign', () => {
    expect(formatPercent(0.46)).toBe(`46${n}%`);
    expect(formatPercent(0.032)).toBe(`3,2${n}%`);
    expect(formatPercent(0.18, { signed: true })).toBe(`+18${n}%`);
    expect(formatPercent(0.0002, { nonZero: true })).toBe(`<0,1${n}%`);
  });

  it('writes days the French way', () => {
    expect(formatDay('2026-11-10')).toBe('10 nov.');
    expect(formatDay('2026-11-01')).toBe('1er nov.');
    expect(formatDay('2026-02-09', { year: true })).toBe('9 févr. 2026');
    expect(formatDay('2026-11-10', { weekday: true })).toBe('mar. 10 nov.');
    expect(formatMonth('2026-08')).toBe('août');
    expect(formatMonth('2025-12', { year: true })).toBe('déc. 2025');
    expect(formatMonth('2026-06', { narrow: true })).toBe('J');
    expect(formatRelativeDay('2026-11-10', '2026-11-10')).toBe('Aujourd’hui');
    expect(formatRelativeDay('2026-11-04', '2026-11-10')).toBe('il y a 6 jours');
    expect(formatDateTime(new Date(2026, 10, 3, 14, 5).toISOString())).toBe('3 nov. 2026 à 14:05');
  });

  it('writes how long ago, with "le" before a day', () => {
    const now = new Date(2026, 10, 10, 12, 0).getTime();
    expect(formatTimeAgo(new Date(now - 4 * 60_000).toISOString(), now)).toBe(`il y a 4${n}min`);
    expect(formatTimeAgo(new Date(2026, 10, 3, 9, 0).toISOString(), now)).toBe('le 3 nov.');
  });

  it('writes durations and sizes with French units', () => {
    expect(formatDuration(36_000)).toBe(`36${n}s`);
    expect(formatDuration(4.1 * 60_000)).toBe(`4,1${n}min`);
    expect(formatDuration(83 * 60_000)).toBe(`1${n}h${n}23`);
    expect(formatDuration(65 * 60_000)).toBe(`1${n}h${n}05`);
    expect(formatDuration(120 * 60_000)).toBe(`2${n}h`);
    expect(formatBytes(812)).toBe(`812${n}o`);
    expect(formatBytes(4.2 * 1024 * 1024)).toBe(`4,2${n}Mo`);
    expect(formatPriceInput(3.75)).toBe('3,75');
  });

  it('goes back to English', () => {
    setLanguage('en');
    expect(formatTokens(12_400_000)).toBe('12.4M');
    expect(formatCost(7.9)).toBe('$7.90');
    expect(formatDay('2026-11-01')).toBe('Nov 1');
    expect(formatTimeAgo(new Date(2026, 10, 3, 9, 0).toISOString(), Date.now())).not.toMatch(
      /^le /,
    );
  });
});
