/**
 * Project names.
 *
 * Container folders: a folder flagged as holding several projects is reported per
 * subfolder, named `<folder> › <subfolder>` (for example `VS Code › Astrophotography_TM`);
 * usage at the top of the folder keeps the folder's name.
 *
 * Aliases: an old project name mapped to a new one, for example after a folder was
 * renamed. They apply to every machine's usage, and to the subfolders of a renamed
 * container folder (`VS Code › website` becomes
 * `Code › website` with the alias `VS Code` → `Code`).
 */

/** Between a container folder and its subfolder in a project name. */
export const PROJECT_SEPARATOR = ' › ';

/** The name a subfolder of a container folder is reported under. */
export function subfolderProject(folder: string, subfolder: string): string {
  return `${folder}${PROJECT_SEPARATOR}${subfolder}`;
}

/** The container folder of a subfolder project, or null for any other project. */
export function containerOf(project: string): string | null {
  const index = project.indexOf(PROJECT_SEPARATOR);
  return index > 0 ? project.slice(0, index) : null;
}

/** The subfolder part of a subfolder project, or the name itself for any other project. */
export function subfolderOf(project: string): string {
  const index = project.indexOf(PROJECT_SEPARATOR);
  return index > 0 ? project.slice(index + PROJECT_SEPARATOR.length) : project;
}

// ── Aliases ───────────────────────────────────────────────────────────────────

/** Usage named `from` is reported as `to`. */
export interface ProjectAlias {
  from: string;
  to: string;
}

/** At most this many aliases, and this long a name. */
export const MAX_ALIASES = 500;
export const MAX_PROJECT_NAME_LENGTH = 1_000;

/** Aliases ready for lookups. A Map, so that no project name can hit an object key. */
export type AliasMap = ReadonlyMap<string, string>;

export function aliasMap(aliases: readonly ProjectAlias[]): AliasMap {
  return new Map(aliases.map((alias) => [alias.from, alias.to]));
}

/**
 * The name `name` ends up with when its aliases are followed, one after the other
 * (`A` → `B` and `B` → `C` give `C`). A cycle stops where it would loop.
 */
export function resolveAlias(name: string, aliases: AliasMap): string {
  let current = name;
  const seen = new Set([name]);
  for (;;) {
    const next = aliases.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * The name a project is reported under once the aliases apply: an alias of the full
 * name first, otherwise an alias of its container folder, which renames the folder part
 * of `<folder> › <subfolder>`.
 */
export function applyAliases(name: string, aliases: AliasMap): string {
  if (aliases.size === 0) return name;
  const direct = resolveAlias(name, aliases);
  if (direct !== name) return direct;
  const folder = containerOf(name);
  if (folder === null) return name;
  const renamed = resolveAlias(folder, aliases);
  if (renamed === folder) return name;
  return resolveAlias(subfolderProject(renamed, subfolderOf(name)), aliases);
}

/**
 * The names flagged as container folders, as the aliases resolve them: a flag set on an
 * old name keeps applying to the folder under its new name, and the other way round.
 */
export function containerTargets(containers: readonly string[], aliases: AliasMap): Set<string> {
  return new Set(containers.map((name) => resolveAlias(name, aliases)));
}

/** Why an alias cannot be added to a list, or null when it can. */
export type AliasProblem = 'empty' | 'same' | 'duplicate' | 'cycle' | 'tooLong' | 'tooMany';

export function aliasProblem(
  existing: readonly ProjectAlias[],
  from: string,
  to: string,
): AliasProblem | null {
  if (from === '' || to === '') return 'empty';
  if (from.length > MAX_PROJECT_NAME_LENGTH || to.length > MAX_PROJECT_NAME_LENGTH) {
    return 'tooLong';
  }
  if (from === to) return 'same';
  if (existing.some((alias) => alias.from === from)) return 'duplicate';
  if (existing.length >= MAX_ALIASES) return 'tooMany';
  // Following the new name must never lead back to the old one. `from` is not a key of
  // the list yet, so a chain from `to` can only end on it, never pass through it.
  if (resolveAlias(to, aliasMap(existing)) === from) return 'cycle';
  return null;
}
