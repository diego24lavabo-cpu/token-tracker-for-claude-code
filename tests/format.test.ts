import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatDay,
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
  });

  it('shows a dash for anything that is not a day', () => {
    expect(formatDay('')).toBe('—');
    expect(formatDay('2026-13-01')).toBe('—');
    expect(formatDay('2026-11-10T12:00:00Z')).toBe('—');
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
