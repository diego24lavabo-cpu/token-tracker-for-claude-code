/**
 * Preferences kept outside the usage database, in `preferences.json` in the data folder:
 * they must work when the database cannot be opened, and in demo mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isLanguageSetting, type LanguageSetting } from '../shared/language';
import { writeAtomic } from './sync';

export const PREFERENCES_FILE = 'preferences.json';

interface Preferences {
  language: LanguageSetting;
}

const DEFAULTS: Preferences = { language: 'system' };

/** The stored preferences; a missing, unreadable or malformed file gives the defaults. */
export function readPreferences(folder: string): Preferences {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(folder, PREFERENCES_FILE), 'utf8'));
    if (typeof value !== 'object' || value === null) return { ...DEFAULTS };
    const language = (value as Record<string, unknown>).language;
    return { language: isLanguageSetting(language) ? language : DEFAULTS.language };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePreferences(folder: string, patch: Partial<Preferences>): Preferences {
  const next = { ...readPreferences(folder), ...patch };
  fs.mkdirSync(folder, { recursive: true });
  writeAtomic(path.join(folder, PREFERENCES_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
