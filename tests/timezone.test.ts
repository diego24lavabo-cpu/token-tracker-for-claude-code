import { describe, expect, it } from 'vitest';
import { createLocalClock, systemTimeZone } from '../electron/timezone';

const at = (iso: string) => Date.parse(iso);

describe('createLocalClock', () => {
  it('buckets one instant differently in each zone', () => {
    const instant = at('2026-11-10T23:30:00Z');
    expect(createLocalClock('UTC').toLocal(instant)).toEqual({ day: '2026-11-10', hour: 23 });
    expect(createLocalClock('Europe/Paris').toLocal(instant)).toEqual({
      day: '2026-11-11',
      hour: 0,
    });
    expect(createLocalClock('Asia/Tokyo').toLocal(instant)).toEqual({ day: '2026-11-11', hour: 8 });
    expect(createLocalClock('America/Los_Angeles').toLocal(instant)).toEqual({
      day: '2026-11-10',
      hour: 15,
    });
  });

  it('handles zones with a half-hour offset', () => {
    const kolkata = createLocalClock('Asia/Kolkata');
    expect(kolkata.toLocal(at('2026-11-10T18:29:59Z'))).toEqual({ day: '2026-11-10', hour: 23 });
    expect(kolkata.toLocal(at('2026-11-10T18:30:00Z'))).toEqual({ day: '2026-11-11', hour: 0 });
  });

  it('follows daylight saving time in spring', () => {
    const paris = createLocalClock('Europe/Paris');
    // 2026-03-29: clocks jump from 02:00 to 03:00.
    expect(paris.toLocal(at('2026-03-29T00:59:59Z'))).toEqual({ day: '2026-03-29', hour: 1 });
    expect(paris.toLocal(at('2026-03-29T01:00:00Z'))).toEqual({ day: '2026-03-29', hour: 3 });

    const newYork = createLocalClock('America/New_York');
    // 2026-03-08: clocks jump from 02:00 to 03:00.
    expect(newYork.toLocal(at('2026-03-08T06:59:59Z'))).toEqual({ day: '2026-03-08', hour: 1 });
    expect(newYork.toLocal(at('2026-03-08T07:00:00Z'))).toEqual({ day: '2026-03-08', hour: 3 });
  });

  it('follows daylight saving time in autumn', () => {
    const paris = createLocalClock('Europe/Paris');
    // 2026-10-25: the hour from 02:00 to 03:00 happens twice.
    expect(paris.toLocal(at('2026-10-25T00:30:00Z'))).toEqual({ day: '2026-10-25', hour: 2 });
    expect(paris.toLocal(at('2026-10-25T01:30:00Z'))).toEqual({ day: '2026-10-25', hour: 2 });
    expect(paris.toLocal(at('2026-10-25T02:30:00Z'))).toEqual({ day: '2026-10-25', hour: 3 });
  });

  it('handles an offset change in the middle of a UTC hour', () => {
    // Lord Howe Island moves from +10:30 to +11:00 at 15:30 UTC.
    const lordHowe = createLocalClock('Australia/Lord_Howe');
    expect(lordHowe.toLocal(at('2026-10-03T15:29:00Z'))).toEqual({ day: '2026-10-04', hour: 1 });
    expect(lordHowe.toLocal(at('2026-10-03T15:30:00Z'))).toEqual({ day: '2026-10-04', hour: 2 });
    expect(lordHowe.toLocal(at('2026-10-03T15:59:00Z'))).toEqual({ day: '2026-10-04', hour: 2 });
    expect(lordHowe.toLocal(at('2026-10-03T16:00:00Z'))).toEqual({ day: '2026-10-04', hour: 3 });
  });

  it('gives the same answer from the cache as on the first call', () => {
    const paris = createLocalClock('Europe/Paris');
    const instant = at('2026-07-14T21:59:59.999Z');
    const first = paris.toLocal(instant);
    expect(first).toEqual({ day: '2026-07-14', hour: 23 });
    expect(paris.toLocal(instant)).toEqual(first);
    expect(paris.toLocal(instant + 1)).toEqual({ day: '2026-07-15', hour: 0 });
  });

  it('crosses year boundaries', () => {
    expect(createLocalClock('Asia/Tokyo').toLocal(at('2026-12-31T15:00:00Z'))).toEqual({
      day: '2027-01-01',
      hour: 0,
    });
    expect(createLocalClock('America/Los_Angeles').toLocal(at('2027-01-01T07:59:59Z'))).toEqual({
      day: '2026-12-31',
      hour: 23,
    });
  });

  it('falls back to UTC for an unknown zone', () => {
    const clock = createLocalClock('Mars/Olympus_Mons');
    expect(clock.timeZone).toBe('UTC');
    expect(clock.toLocal(at('2026-11-10T23:30:00Z'))).toEqual({ day: '2026-11-10', hour: 23 });
  });
});

describe('systemTimeZone', () => {
  it('returns a zone Intl accepts', () => {
    const zone = systemTimeZone();
    expect(zone.length).toBeGreaterThan(0);
    expect(createLocalClock(zone).timeZone).toBe(zone);
  });
});
