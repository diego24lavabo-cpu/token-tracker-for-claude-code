/**
 * Claude Code's `cleanupPeriodDays` setting: how many days it keeps session transcripts.
 *
 * The app only ever writes Claude Code's settings file after the user confirmed it, keeps
 * every other setting in it, and never touches a file it cannot parse.
 */
import fs from 'node:fs';
import path from 'node:path';

/** What Claude Code uses when `cleanupPeriodDays` is not set. */
export const DEFAULT_CLEANUP_DAYS = 30;
/** The value offered by "Keep Claude Code history longer". */
export const SUGGESTED_CLEANUP_DAYS = 365;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

export interface RetentionState {
  /** False when the file is missing. */
  exists: boolean;
  /** False when the file exists but is not a JSON object. */
  readable: boolean;
  /** The value set in the file, or null when it is missing or not a positive number. */
  cleanupPeriodDays: number | null;
}

function readObject(file: string): { exists: boolean; value: Record<string, unknown> | null } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { exists: !missing, value: null };
  }
  try {
    // An editor may have saved it with a byte order mark.
    const clean = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
    const parsed: unknown = JSON.parse(clean);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { exists: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // Not JSON: reported as unreadable below.
  }
  return { exists: true, value: null };
}

export function readRetention(file: string): RetentionState {
  const { exists, value } = readObject(file);
  const days = value?.cleanupPeriodDays;
  return {
    exists,
    readable: !exists || value !== null,
    cleanupPeriodDays:
      typeof days === 'number' && Number.isFinite(days) && days > 0 ? Math.floor(days) : null,
  };
}

/**
 * Sets `cleanupPeriodDays` in the file, keeping every other setting. A missing file is
 * created (its folder must exist). Throws without writing when the file cannot be parsed.
 */
export function writeCleanupDays(file: string, days: number): void {
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
  const { exists, value } = readObject(file);
  if (exists && value === null) throw new Error('The settings file is not valid JSON');
  if (!fs.statSync(path.dirname(file)).isDirectory()) throw new Error('No Claude folder');

  const next = { ...(value ?? {}), cleanupPeriodDays: days };
  const temporary = `${file}.token-tracker.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
