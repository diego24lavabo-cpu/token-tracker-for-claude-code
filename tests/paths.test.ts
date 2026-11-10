import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  candidateLogRoots,
  defaultLogRoot,
  existingLogRoots,
  tildify,
  type PathEnv,
} from '../electron/paths';

const mac: PathEnv = { home: '/Users/alex', env: {}, platform: 'darwin' };
const win: PathEnv = { home: 'C:\\Users\\alex', env: {}, platform: 'win32' };

describe('candidateLogRoots', () => {
  it('lists the default folders on macOS', () => {
    expect(candidateLogRoots(mac)).toEqual([
      '/Users/alex/.claude/projects',
      '/Users/alex/.config/claude/projects',
    ]);
  });

  it('lists the default folders on Windows with backslashes', () => {
    expect(candidateLogRoots(win)).toEqual([
      'C:\\Users\\alex\\.claude\\projects',
      'C:\\Users\\alex\\.config\\claude\\projects',
    ]);
  });

  it('puts CLAUDE_CONFIG_DIR first and accepts several folders', () => {
    const roots = candidateLogRoots({
      ...mac,
      env: { CLAUDE_CONFIG_DIR: '/Volumes/work/claude, /opt/claude' },
    });
    expect(roots).toEqual([
      '/Volumes/work/claude/projects',
      '/opt/claude/projects',
      '/Users/alex/.claude/projects',
      '/Users/alex/.config/claude/projects',
    ]);
  });

  it('honors XDG_CONFIG_HOME', () => {
    const roots = candidateLogRoots({ ...mac, env: { XDG_CONFIG_HOME: '/Users/alex/.xdg' } });
    expect(roots).toContain('/Users/alex/.xdg/claude/projects');
    expect(roots).not.toContain('/Users/alex/.config/claude/projects');
  });

  it('removes duplicates, ignoring case and trailing separators on Windows', () => {
    const roots = candidateLogRoots({
      ...win,
      env: { CLAUDE_CONFIG_DIR: 'c:\\users\\ALEX\\.claude\\' },
    });
    expect(roots).toEqual([
      'c:\\users\\ALEX\\.claude\\projects',
      'C:\\Users\\alex\\.config\\claude\\projects',
    ]);
  });

  it('keeps paths that differ only by case on Linux', () => {
    const roots = candidateLogRoots({
      home: '/home/alex',
      env: { CLAUDE_CONFIG_DIR: '/home/alex/.Claude' },
      platform: 'linux',
    });
    expect(roots).toHaveLength(3);
  });
});

describe('defaultLogRoot', () => {
  it('uses the separator of the platform', () => {
    expect(defaultLogRoot(mac)).toBe('/Users/alex/.claude/projects');
    expect(defaultLogRoot(win)).toBe('C:\\Users\\alex\\.claude\\projects');
  });
});

describe('tildify', () => {
  it('shortens paths inside the home folder', () => {
    expect(tildify('/Users/alex/.claude/projects', mac)).toBe('~/.claude/projects');
    expect(tildify('C:\\Users\\alex\\.claude\\projects', win)).toBe('~\\.claude\\projects');
    expect(tildify('/Users/alex', mac)).toBe('~');
  });

  it('leaves other paths alone', () => {
    expect(tildify('/Volumes/work/claude/projects', mac)).toBe('/Volumes/work/claude/projects');
    expect(tildify('/Users/alexandra/.claude', mac)).toBe('/Users/alexandra/.claude');
    expect(tildify('D:\\claude\\projects', win)).toBe('D:\\claude\\projects');
  });
});

describe('existingLogRoots', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-tracker-paths-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns only the folders that exist', () => {
    const pathEnv: PathEnv = { home, env: {}, platform: process.platform };
    expect(existingLogRoots(pathEnv)).toEqual([]);

    const projects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(projects, { recursive: true });
    expect(existingLogRoots(pathEnv)).toEqual([projects]);
  });

  it('ignores a file that sits where the folder should be', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'projects'), '');
    expect(existingLogRoots({ home, env: {}, platform: process.platform })).toEqual([]);
  });
});
