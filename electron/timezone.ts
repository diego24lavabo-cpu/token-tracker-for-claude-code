/**
 * Conversion of UTC timestamps to local days and hours.
 *
 * Timestamps are stored in UTC. Days and hours are derived from them in the system's time
 * zone (never a hardcoded one), using Intl so the result does not depend on the platform's
 * C library.
 */

/** The IANA name of the system's time zone, for example `Europe/Paris`. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface LocalTime {
  /** Local day, `YYYY-MM-DD`. */
  day: string;
  /** Local hour, 0 to 23. */
  hour: number;
}

/** A local time down to the minute. */
export interface LocalMinute extends LocalTime {
  /** 0 to 59. */
  minute: number;
}

export interface LocalClock {
  /** The zone actually used; `UTC` when the requested zone is unknown. */
  readonly timeZone: string;
  toLocal(timestampMs: number): LocalTime;
  toLocalMinute(timestampMs: number): LocalMinute;
}

/** Zone offsets only change on quarter-hour boundaries, so one lookup per quarter is enough. */
const OFFSET_BUCKET_MS = 15 * 60 * 1000;

function createFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Creates a converter for one time zone. Asking Intl for every record would be slow on a
 * first import, so the zone offset is cached per quarter-hour of UTC time.
 */
export function createLocalClock(timeZone: string): LocalClock {
  let zone = timeZone;
  let format: Intl.DateTimeFormat;
  try {
    format = createFormat(zone);
  } catch {
    zone = 'UTC';
    format = createFormat(zone);
  }

  const offsets = new Map<number, number>();

  const offsetAt = (timestampMs: number): number => {
    const bucket = Math.floor(timestampMs / OFFSET_BUCKET_MS);
    const cached = offsets.get(bucket);
    if (cached !== undefined) return cached;

    const instant = bucket * OFFSET_BUCKET_MS;
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(instant)) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(
      parts.year ?? 1970,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    const offset = asUtc - instant;
    offsets.set(bucket, offset);
    return offset;
  };

  return {
    timeZone: zone,
    toLocal(timestampMs) {
      const local = new Date(timestampMs + offsetAt(timestampMs));
      return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
    },
    toLocalMinute(timestampMs) {
      const local = new Date(timestampMs + offsetAt(timestampMs));
      return {
        day: local.toISOString().slice(0, 10),
        hour: local.getUTCHours(),
        minute: local.getUTCMinutes(),
      };
    },
  };
}
