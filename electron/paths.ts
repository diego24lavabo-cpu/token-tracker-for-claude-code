import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PathEnv {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

function currentEnv(): PathEnv {
  return { home: os.homedir(), env: process.env, platform: process.platform };
}

/** The path flavor of the given platform, so Windows paths can be handled on a Mac and back. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function stripTrailingSeparators(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

/** Compares paths the way the file system does: case-insensitive on Windows and macOS. */
function pathKey(p: string, platform: NodeJS.Platform): string {
  const normalized = stripTrailingSeparators(pathFor(platform).normalize(p));
  return platform === 'linux' ? normalized : normalized.toLowerCase();
}

/**
 * Every folder where Claude Code may write its `projects` transcripts, in priority order
 * and without duplicates. The folders are not checked for existence here.
 */
export function candidateLogRoots(pathEnv: PathEnv = currentEnv()): string[] {
  const { home, env, platform } = pathEnv;
  const p = pathFor(platform);
  const candidates: string[] = [];

  // CLAUDE_CONFIG_DIR may list several folders separated by commas.
  const configDirs = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of configDirs) {
    candidates.push(p.join(dir, 'projects'));
  }

  candidates.push(p.join(home, '.claude', 'projects'));

  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  candidates.push(p.join(xdgConfig || p.join(home, '.config'), 'claude', 'projects'));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = pathKey(candidate, platform);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The candidate log folders that exist on this machine. */
export function existingLogRoots(pathEnv: PathEnv = currentEnv()): string[] {
  return candidateLogRoots(pathEnv).filter(isDirectory);
}

/** The folder shown to the user when no log folder exists yet. */
export function defaultLogRoot(pathEnv: PathEnv = currentEnv()): string {
  return pathFor(pathEnv.platform).join(pathEnv.home, '.claude', 'projects');
}

/** Shortens a path for display by replacing the home folder with `~`. */
export function tildify(target: string, pathEnv: PathEnv = currentEnv()): string {
  const { home, platform } = pathEnv;
  const p = pathFor(platform);
  const full = stripTrailingSeparators(p.normalize(target));
  const homeKey = pathKey(home, platform);
  const fullKey = platform === 'linux' ? full : full.toLowerCase();
  if (fullKey === homeKey) return '~';
  if (fullKey.startsWith(homeKey + p.sep)) {
    return '~' + full.slice(homeKey.length);
  }
  return full;
}
