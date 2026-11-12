/** Sync rules shared by the main process and the UI. */

/** A machine that has not written its sync files for longer than this is flagged. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whole days since a machine last wrote its sync files, when that is more than
 * `STALE_AFTER_MS` ago; null when it synced recently or never did.
 */
export function staleDays(lastSync: string | null, now: number): number | null {
  if (!lastSync) return null;
  const at = Date.parse(lastSync);
  if (!Number.isFinite(at) || now - at <= STALE_AFTER_MS) return null;
  return Math.floor((now - at) / (24 * 60 * 60 * 1000));
}
