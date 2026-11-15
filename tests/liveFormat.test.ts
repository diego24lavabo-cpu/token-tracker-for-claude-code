/** `live.json`: how another computer's file is checked before the Live page uses it. */
import { describe, expect, it } from 'vitest';
import {
  isLiveFresh,
  LIVE_FRESH_MS,
  LIVE_SCHEMA_VERSION,
  LIVE_SKEW_MS,
  parseLiveFile,
  serializeLiveFile,
  versionBefore,
  type LiveFile,
} from '../electron/liveFormat';

const ID = 'f4627a72-0000-4000-8000-000000000001';
const AT = Date.parse('2026-11-15T10:00:30Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function file(patch: Partial<LiveFile> = {}): LiveFile {
  return {
    schemaVersion: LIVE_SCHEMA_VERSION,
    machineId: ID,
    writtenAt: AT,
    minutesFrom: AT - 6 * HOUR,
    activityFrom: AT - 24 * HOUR,
    window: {
      start: AT - HOUR,
      last: AT - MINUTE,
      responses: 3,
      models: [['Opus 5.5', 10, 20, 30, 40, 5]],
    },
    previous: null,
    activity: [[AT - HOUR, AT - MINUTE]],
    minutes: [[AT - MINUTE - 20_000, AT - MINUTE, 'demo-app', 'Opus 5.5', 10, 20, 30, 40, 5, 3]],
    ...patch,
  };
}

const text = (value: unknown) => JSON.stringify(value);

describe('parseLiveFile', () => {
  it('reads back what was written', () => {
    const written = file();
    const serialized = serializeLiveFile(written);
    // One row per line, so a person can read it.
    expect(serialized.split('\n').length).toBeGreaterThan(5);
    expect(parseLiveFile(serialized, ID)).toEqual({ ok: true, skippedRows: 0, value: written });
    // A BOM (a Windows editor) is fine.
    expect(parseLiveFile(`${String.fromCharCode(0xfeff)}${serialized}`, ID).ok).toBe(true);
  });

  it('refuses a partial file, a newer format and another machine’s file', () => {
    const serialized = serializeLiveFile(file());
    expect(parseLiveFile(serialized.slice(0, 40), ID)).toEqual({ ok: false, reason: 'json' });
    expect(parseLiveFile('[]', ID)).toEqual({ ok: false, reason: 'format' });
    expect(parseLiveFile(text(file({ schemaVersion: 2 })), ID)).toEqual({
      ok: false,
      reason: 'newerVersion',
    });
    expect(parseLiveFile(serialized, 'c33d0000-0000-4000-8000-000000000002')).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses a file whose times or windows are not as written by the app', () => {
    const refused = (patch: Record<string, unknown>) =>
      parseLiveFile(text({ ...file(), ...patch }), ID);
    expect(refused({ writtenAt: '2026-11-15T10:00:30Z' })).toEqual({ ok: false, reason: 'format' });
    expect(refused({ writtenAt: 1.5 })).toEqual({ ok: false, reason: 'format' });
    expect(refused({ minutesFrom: AT + 1 })).toEqual({ ok: false, reason: 'format' });
    expect(refused({ writtenAt: Date.parse('2101-01-01T00:00:00Z') }).ok).toBe(false);
    // A window longer than 5 hours, or without responses.
    const window = file().window!;
    expect(refused({ window: { ...window, last: window.start + 5 * HOUR } }).ok).toBe(false);
    expect(refused({ window: { ...window, responses: 0 } }).ok).toBe(false);
    expect(refused({ previous: { ...window, models: [['Opus 5.5', -1, 0, 0, 0, 0]] } }).ok).toBe(
      false,
    );
    expect(refused({ activity: 'none' }).ok).toBe(false);
  });

  it('skips a malformed row and keeps the others', () => {
    const good = file().minutes[0]!;
    const parsed = parseLiveFile(
      text({
        ...file(),
        minutes: [
          good,
          [AT - MINUTE, AT, 'demo-app', 'Opus 5.5', 1, 1, 1, 1, 0, 1], // two different minutes
          [AT - MINUTE, AT - MINUTE, '', 'Opus 5.5', 1, 1, 1, 1, 0, 1], // no project
          [AT - MINUTE, AT - MINUTE, 'demo-app', 'Opus 5.5', 1, 1, 1, 1, 2, 1], // 1-hour > writes
          [AT - MINUTE, AT - MINUTE, 'demo-app', 'Opus 5.5', 1, 1, 1, 1, 0, 0], // no response
          [AT + MINUTE, AT + MINUTE, 'demo-app', 'Opus 5.5', 1, 1, 1, 1, 0, 1], // after writing
          [AT - 7 * HOUR, AT - 7 * HOUR, 'demo-app', 'Opus 5.5', 1, 1, 1, 1, 0, 1], // before
        ],
        activity: [
          [AT - HOUR, AT - MINUTE],
          [AT, AT - MINUTE],
          [AT - 25 * HOUR, AT - 25 * HOUR],
        ],
      }),
      ID,
    );
    expect(parsed.ok && parsed.value.minutes).toEqual([good]);
    expect(parsed.ok && parsed.value.activity).toEqual([[AT - HOUR, AT - MINUTE]]);
    expect(parsed.ok && parsed.skippedRows).toBe(8);
  });
});

describe('isLiveFresh', () => {
  it('is fresh for 15 minutes, and not when dated well ahead of this clock', () => {
    expect(isLiveFresh({ writtenAt: AT }, AT + LIVE_FRESH_MS)).toBe(true);
    expect(isLiveFresh({ writtenAt: AT }, AT + LIVE_FRESH_MS + 1)).toBe(false);
    expect(isLiveFresh({ writtenAt: AT + LIVE_SKEW_MS }, AT)).toBe(true);
    expect(isLiveFresh({ writtenAt: AT + LIVE_SKEW_MS + 1 }, AT)).toBe(false);
  });
});

describe('versionBefore', () => {
  it('compares versions number by number, an unknown one never older', () => {
    expect(versionBefore('0.1.1', '0.1.2')).toBe(true);
    expect(versionBefore('0.1.2', '0.1.2')).toBe(false);
    expect(versionBefore('0.1.10', '0.1.2')).toBe(false);
    expect(versionBefore('0.2.0', '0.1.2')).toBe(false);
    expect(versionBefore('v0.0.9', '0.1.2')).toBe(true);
    expect(versionBefore('0.1.2-beta.1', '0.1.2')).toBe(false);
    expect(versionBefore(null, '0.1.2')).toBe(false);
    expect(versionBefore('dev', '0.1.2')).toBe(false);
  });
});
