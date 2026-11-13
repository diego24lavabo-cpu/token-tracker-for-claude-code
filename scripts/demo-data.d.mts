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
}

/** Writes a synthetic Claude Code `projects` folder and returns the number of sessions. */
export function generateDemoData(output: string, options?: DemoDataOptions): number;
