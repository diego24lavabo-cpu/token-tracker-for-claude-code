import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysInRange,
  eachDay,
  isDay,
  localDay,
  periodRange,
  previousRange,
} from '../shared/period';

describe('isDay', () => {
  it('accepts real calendar days only', () => {
    expect(isDay('2026-11-10')).toBe(true);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('2026-1-5')).toBe(false);
    expect(isDay('2026-11-10T00:00:00Z')).toBe(false);
    expect(isDay(20261110)).toBe(false);
    expect(isDay(null)).toBe(false);
  });
});

describe('day arithmetic', () => {
  it('moves across months, years and leap days', () => {
    expect(addDays('2026-11-10', 1)).toBe('2026-11-11');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-11-10', 0)).toBe('2026-11-10');
  });

  it('counts the days of a range, both ends included', () => {
    expect(daysInRange('2026-11-10', '2026-11-10')).toBe(1);
    expect(daysInRange('2026-10-12', '2026-11-10')).toBe(30);
    // Days are counted on the calendar: a clock change does not add or remove one.
    expect(daysInRange('2026-10-24', '2026-10-26')).toBe(3);
    expect(daysInRange('2026-11-10', '2026-11-09')).toBe(0);
  });

  it('lists the days of a range', () => {
    expect(eachDay('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(eachDay('2026-11-10', '2026-11-10')).toEqual(['2026-11-10']);
    expect(eachDay('2026-11-10', '2026-11-09')).toEqual([]);
  });
});

describe('periodRange', () => {
  it('ends today and covers the number of days of the period', () => {
    expect(periodRange('7d', '2026-11-10')).toEqual({ from: '2026-11-04', to: '2026-11-10' });
    expect(periodRange('30d', '2026-11-10')).toEqual({ from: '2026-10-12', to: '2026-11-10' });
    expect(periodRange('90d', '2026-11-10')).toEqual({ from: '2026-08-13', to: '2026-11-10' });
    expect(periodRange('1y', '2026-11-10')).toEqual({ from: '2025-11-11', to: '2026-11-10' });
    for (const period of ['7d', '30d', '90d', '1y'] as const) {
      const { from, to } = periodRange(period, '2026-11-10');
      expect(daysInRange(from, to)).toBe({ '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period]);
    }
  });
});

describe('previousRange', () => {
  it('is the range of the same length just before', () => {
    expect(previousRange('2026-10-12', '2026-11-10')).toEqual({
      from: '2026-09-12',
      to: '2026-10-11',
    });
    expect(previousRange('2026-11-10', '2026-11-10')).toEqual({
      from: '2026-11-09',
      to: '2026-11-09',
    });
  });
});

describe('localDay', () => {
  it('reads the calendar day shown by the system clock', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59, 59))).toBe('2026-01-05');
    expect(localDay(new Date(2026, 10, 10, 0, 0, 0))).toBe('2026-11-10');
  });
});
