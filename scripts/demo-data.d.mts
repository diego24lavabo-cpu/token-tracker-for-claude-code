export const DEMO_MARKER: string;
export const DEMO_PROJECTS: readonly string[];

export interface DemoDataOptions {
  /** Last day of the data, `YYYY-MM-DD` (default: today). */
  endDay?: string;
  /** Number of days that end with `endDay` (default 35). */
  days?: number;
  /** Seed of the random numbers: the same seed and days give the same data (default 42). */
  seed?: number;
  /** Path style of the fake projects: `C:\Users\alex\dev\…` or `/Users/alex/dev/…`. */
  paths?: 'windows' | 'posix';
  projects?: readonly string[];
  /** Fewest and most sessions on a day with activity (default 1 to 3). */
  sessionsPerDay?: readonly [number, number];
  /** Share of days without any session (default 0.2). */
  dayOffRate?: number;
  /**
   * The current time, epoch milliseconds. When set, two more sessions are written that end
   * at this time or before it: one still running and one that stopped about an hour
   * earlier, so the Live page has a running window (default: none).
   */
  liveAt?: number;
  /**
   * With `liveAt`: how many minutes before it the running session started (default 170).
   * A second computer started earlier makes the combined window start on it.
   */
  liveStartMinutes?: number;
  /**
   * With `liveAt`: how many minutes before it that session's last response is (default: a
   * few seconds, so it is still running).
   */
  liveEndMinutes?: number;
  /** With `liveAt`: 2 sessions (default), or only the first one. */
  liveSessions?: 1 | 2;
}

/** Seeded random numbers in [0, 1) (mulberry32). */
export function createRandom(seed: number): () => number;

/** Writes a synthetic Claude Code `projects` folder and returns the number of sessions. */
export function generateDemoData(output: string, options?: DemoDataOptions): number;
