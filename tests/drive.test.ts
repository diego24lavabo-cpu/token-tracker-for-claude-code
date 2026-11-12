import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountFromLabel,
  findDriveRoots,
  syncFolderFromPick,
  type DirEntry,
  type DriveEnv,
} from '../electron/drive';

/** A fake file system: every folder path with its entries (a trailing `/` marks a folder). */
function fakeDrive(
  platform: NodeJS.Platform,
  home: string,
  tree: Record<string, string[]>,
): DriveEnv {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const folders = new Map(
    Object.entries(tree).map(([dir, entries]) => [p.normalize(dir).toLowerCase(), entries]),
  );
  return {
    platform,
    home,
    env: {},
    readDir: async (dir) => {
      const entries = folders.get(p.normalize(dir).toLowerCase());
      if (!entries) return null;
      return entries.map((entry): DirEntry => ({
        name: entry.replace(/\/$/, ''),
        isDirectory: entry.endsWith('/'),
      }));
    },
  };
}

describe('Google Drive on Windows', () => {
  it('finds every account on its drive letter, in any language', async () => {
    // The layout of Google Drive for desktop with two accounts, in French.
    const drive = fakeDrive('win32', 'C:\\Users\\alex', {
      'G:\\': ['Mon Drive/', '.shortcut-targets-by-id/', '$RECYCLE.BIN/', '.Encrypted/'],
      'H:\\': ['Mon Drive/', '.shortcut-targets-by-id/', 'Drive partagés/', '$RECYCLE.BIN/'],
      // A data disk that happens to have a "My Drive" folder is not Google Drive.
      'E:\\': ['Document/', 'My Drive/', 'Recovery/'],
      'C:\\Users\\alex': ['Documents/', 'Downloads/'],
    });
    expect(await findDriveRoots(drive)).toEqual([
      { path: 'G:\\Mon Drive', account: null },
      { path: 'H:\\Mon Drive', account: null },
    ]);
  });

  it('recognises an unknown language when only one folder is left', async () => {
    const drive = fakeDrive('win32', 'C:\\Users\\alex', {
      'G:\\': ['Minha Unidade X/', 'Shared drives/', '.shortcut-targets-by-id/'],
      'K:\\': ['One/', 'Two/', '.shortcut-targets-by-id/'],
    });
    expect(await findDriveRoots(drive)).toEqual([{ path: 'G:\\Minha Unidade X', account: null }]);
  });

  it('finds the older client and a mirrored My Drive in the user folder', async () => {
    const drive = fakeDrive('win32', 'C:\\Users\\alex', {
      'C:\\Users\\alex': ['Google Drive/', 'Meine Ablage/', 'Documents/'],
      'C:\\Users\\alex\\Google Drive': ['notes.txt'],
    });
    expect(await findDriveRoots(drive)).toEqual([
      { path: 'C:\\Users\\alex\\Google Drive', account: null },
      { path: 'C:\\Users\\alex\\Meine Ablage', account: null },
    ]);
  });

  it('reads the account from the volume label', () => {
    expect(accountFromLabel('alex@example.com - Google Drive')).toBe('alex@example.com');
    // Windows cuts volume labels to 32 characters.
    expect(accountFromLabel('alex.martin@example.com - Goo...')).toBe('alex.martin@example.com');
    expect(accountFromLabel('alex@school.example - Google...')).toBe('alex@school.example');
    expect(accountFromLabel('Google Drive')).toBeNull();
    expect(accountFromLabel('Backup - Photos')).toBeNull();
    expect(accountFromLabel('Data')).toBeNull();
  });
});

describe('Google Drive on macOS', () => {
  it('finds every GoogleDrive-<account> folder in CloudStorage', async () => {
    const drive = fakeDrive('darwin', '/Users/alex', {
      '/Users/alex/Library/CloudStorage': [
        'GoogleDrive-alex@example.com/',
        'GoogleDrive-work@example.com/',
        'OneDrive-Personal/',
      ],
      '/Users/alex/Library/CloudStorage/GoogleDrive-alex@example.com': [
        'My Drive/',
        'Shared drives/',
        '.shortcut-targets-by-id/',
        'Icon\r',
      ],
      '/Users/alex/Library/CloudStorage/GoogleDrive-work@example.com': [
        'Mi unidad/',
        'Otros ordenadores/',
      ],
    });
    expect(await findDriveRoots(drive)).toEqual([
      {
        path: '/Users/alex/Library/CloudStorage/GoogleDrive-alex@example.com/My Drive',
        account: 'alex@example.com',
      },
      {
        path: '/Users/alex/Library/CloudStorage/GoogleDrive-work@example.com/Mi unidad',
        account: 'work@example.com',
      },
    ]);
  });

  it('finds the older volume, and nothing on a machine without Google Drive', async () => {
    const drive = fakeDrive('darwin', '/Users/alex', {
      '/Volumes': ['Macintosh HD/', 'GoogleDrive/'],
      '/Volumes/GoogleDrive': ['Mon Drive/', 'Drives partagés/'],
    });
    expect(await findDriveRoots(drive)).toEqual([
      { path: '/Volumes/GoogleDrive/Mon Drive', account: null },
    ]);
    expect(await findDriveRoots(fakeDrive('darwin', '/Users/alex', {}))).toEqual([]);
    expect(await findDriveRoots(fakeDrive('linux', '/home/alex', {}))).toEqual([]);
  });
});

describe('a folder picked by hand', () => {
  it("syncs in the app's folder inside it", () => {
    const p = process.platform === 'win32' ? path.win32 : path.posix;
    const myDrive = p.join(p.sep === '\\' ? 'G:\\' : '/', 'Mon Drive');
    expect(syncFolderFromPick(myDrive, 'ClaudeTokenTracker')).toBe(
      p.join(myDrive, 'ClaudeTokenTracker'),
    );
    expect(syncFolderFromPick(p.join(myDrive, 'ClaudeTokenTracker'), 'ClaudeTokenTracker')).toBe(
      p.join(myDrive, 'ClaudeTokenTracker'),
    );
  });
});
