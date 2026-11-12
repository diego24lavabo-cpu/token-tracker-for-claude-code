/**
 * App preferences kept in the database's `settings` table, the container folder
 * candidates shown in Settings, and the checks on changes sent by the UI.
 */
import type { ContainerCandidate, CsvKind, SettingsPatch } from '../shared/types';
import { InvalidRequestError } from './aggregate';
import { CSV_KINDS } from './csv';
import type { UsageDatabase } from './db';
import { validatePricing } from './pricing';

const SETTING_FILE_WATCHING = 'file_watching';
const SETTING_EXTRA_ROOTS = 'extra_log_roots';

const MAX_CONTAINERS = 500;
const MAX_NAME_LENGTH = 1_000;
const MAX_PATH_LENGTH = 4_096;
const TOP_SUBFOLDERS = 4;

/** File watching is on unless the user turned it off. */
export function getFileWatching(db: UsageDatabase): boolean {
  return db.getSetting(SETTING_FILE_WATCHING) !== '0';
}

export function setFileWatching(db: UsageDatabase, on: boolean): void {
  db.setSetting(SETTING_FILE_WATCHING, on ? '1' : '0');
}

/** The `projects` folders added by the user, as absolute paths. */
export function getExtraLogRoots(db: UsageDatabase): string[] {
  const stored = db.getSetting(SETTING_EXTRA_ROOTS);
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item !== '')
      : [];
  } catch {
    return [];
  }
}

export function setExtraLogRoots(db: UsageDatabase, roots: readonly string[]): void {
  db.setSetting(SETTING_EXTRA_ROOTS, JSON.stringify([...new Set(roots)]));
}

/**
 * Folder projects that may hold several projects: those with usage in subfolders, plus
 * the ones already flagged. Flagged first, then by the tokens used in subfolders.
 */
export function getContainerCandidates(db: UsageDatabase): ContainerCandidate[] {
  const flagged = new Set(db.getContainerProjects());
  const byProject = new Map<string, { tokens: number; subfolders: Map<string, number> }>();

  for (const row of db.folderUsage()) {
    let entry = byProject.get(row.project);
    if (!entry) {
      entry = { tokens: 0, subfolders: new Map() };
      byProject.set(row.project, entry);
    }
    entry.tokens += row.tokens;
    if (row.subfolder !== '') entry.subfolders.set(row.subfolder, row.tokens);
  }
  for (const name of flagged) {
    if (!byProject.has(name)) byProject.set(name, { tokens: 0, subfolders: new Map() });
  }

  const candidates: ContainerCandidate[] = [];
  for (const [name, entry] of byProject) {
    if (entry.subfolders.size === 0 && !flagged.has(name)) continue;
    const subfolders = [...entry.subfolders].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const subfolderTokens = subfolders.reduce((sum, [, tokens]) => sum + tokens, 0);
    candidates.push({
      name,
      flagged: flagged.has(name),
      tokens: entry.tokens,
      subfolderShare: entry.tokens > 0 ? subfolderTokens / entry.tokens : 0,
      subfolderCount: subfolders.length,
      topSubfolders: subfolders.slice(0, TOP_SUBFOLDERS).map(([subfolder]) => subfolder),
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.flagged) - Number(a.flagged) ||
      b.tokens * b.subfolderShare - a.tokens * a.subfolderShare ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return candidates;
}

/** Checks a settings change received over IPC and returns a clean copy. */
export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError('the settings change must be an object');
  }
  const input = value as Record<string, unknown>;
  const patch: SettingsPatch = {};

  for (const key of ['launchAtLogin', 'fileWatching'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new InvalidRequestError(`${key} must be a boolean`);
    patch[key] = input[key];
  }

  if (input.containerProjects !== undefined) {
    const list = input.containerProjects;
    if (
      !Array.isArray(list) ||
      list.length > MAX_CONTAINERS ||
      !list.every(
        (item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_NAME_LENGTH,
      )
    ) {
      throw new InvalidRequestError('containerProjects must be a list of project names');
    }
    patch.containerProjects = list as string[];
  }

  if (input.pricing !== undefined) {
    try {
      patch.pricing = validatePricing(input.pricing);
    } catch (error) {
      throw new InvalidRequestError(error instanceof Error ? error.message : 'invalid pricing');
    }
  }
  return patch;
}

export function parseCsvKind(value: unknown): CsvKind {
  if (typeof value !== 'string' || !(CSV_KINDS as readonly string[]).includes(value)) {
    throw new InvalidRequestError('unknown export');
  }
  return value as CsvKind;
}

export function parseFolderPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new InvalidRequestError('folder must be a path');
  }
  return value;
}

/** Models with usage on any machine, all time, most tokens first. */
export function getUsedModels(db: UsageDatabase): { name: string; tokens: number }[] {
  return db.raw
    .prepare(
      `SELECT model AS name, SUM(input + output + cache_write + cache_read) AS tokens
       FROM hourly GROUP BY model HAVING tokens > 0 ORDER BY tokens DESC, model`,
    )
    .all() as { name: string; tokens: number }[];
}
