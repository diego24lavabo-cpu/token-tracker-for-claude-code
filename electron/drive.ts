/**
 * Finding the "My Drive" folder of Google Drive for desktop, for any account and in any
 * language, without asking Google anything: only local folders are looked at.
 *
 * - macOS: `~/Library/CloudStorage/GoogleDrive-<account>/<My Drive>`, plus the older
 *   `/Volumes/GoogleDrive/<My Drive>` and `~/Google Drive`.
 * - Windows: every drive letter whose root looks like a Google Drive (default `G:\`),
 *   plus `%USERPROFILE%\Google Drive` (older clients) and a mirrored `My Drive` folder.
 *
 * "My Drive" is recognised by its name in many languages; when the name is unknown, a
 * Drive root that holds a single ordinary folder besides "Shared drives" is enough.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** "My Drive" in the languages of Google Drive for desktop. Compared without case. */
export const MY_DRIVE_NAMES = [
  'My Drive',
  'Mon Drive',
  'Meine Ablage',
  'Mi unidad',
  'Il mio Drive',
  'Meu Drive',
  'O meu disco',
  'Mijn Drive',
  'Min enhet',
  'Mit drev',
  'Min disk',
  'Oma Drive',
  'Mój dysk',
  'Můj disk',
  'Môj disk',
  'Saját meghajtó',
  'Drive-ul meu',
  'Moj disk',
  'Moj pogon',
  'Мой диск',
  'Мій диск',
  'Моят диск',
  'Ο Δίσκος μου',
  'Drive\u2019ım',
  "Drive'ım",
  'Drive Saya',
  'Drive Của tôi',
  'ไดรฟ์ของฉัน',
  'マイドライブ',
  '내 드라이브',
  '我的云端硬盘',
  '我的雲端硬碟',
  'האחסון שלי',
  'drive الخاص بي',
  'मेरी ड्राइव',
];

/** Folders next to "My Drive" that are never it. */
const OTHER_DRIVE_FOLDERS = [
  'Shared drives',
  'Drives partagés',
  'Geteilte Ablagen',
  'Unidades compartidas',
  'Drive condivisi',
  'Drives compartilhados',
  'Gedeelde drives',
  'Delade enheter',
  'Other computers',
  'Autres ordinateurs',
  'Andere Computer',
  'Otros ordenadores',
  'Altri computer',
  'Outros computadores',
  'Computers',
  'Ordinateurs',
  'Computer',
  'Ordenadores',
];

/** A hidden folder Google Drive for desktop keeps at the root of each account. */
const DRIVE_MARKER = '.shortcut-targets-by-id';

const lower = (names: readonly string[]) => new Set(names.map((name) => name.toLowerCase()));
const MY_DRIVE = lower(MY_DRIVE_NAMES);
const OTHERS = lower(OTHER_DRIVE_FOLDERS);

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface DriveEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** The entries of a folder, or null when it cannot be read. */
  readDir(dir: string): Promise<DirEntry[] | null>;
}

export interface DriveRoot {
  /** The "My Drive" folder. */
  path: string;
  /** The account, when the folder names it (macOS) or the volume label does (Windows). */
  account: string | null;
}

/** How long one folder may take to list before it counts as unreadable. */
const LIST_TIMEOUT_MS = 3_000;

async function listWithTimeout(dir: string): Promise<DirEntry[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LIST_TIMEOUT_MS);
  });
  const listing = fs.promises
    .readdir(dir, { withFileTypes: true })
    .then((entries) =>
      entries.map((entry) => ({
        name: entry.name,
        // Drive folders can be reparse points on Windows: they are folders too.
        isDirectory: entry.isDirectory() || entry.isSymbolicLink(),
      })),
    )
    .catch(() => null);
  try {
    return await Promise.race([listing, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function currentDriveEnv(): DriveEnv {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    readDir: listWithTimeout,
  };
}

function isOrdinaryFolder(entry: DirEntry): boolean {
  return (
    entry.isDirectory &&
    !entry.name.startsWith('.') &&
    !entry.name.startsWith('$') &&
    entry.name !== 'System Volume Information'
  );
}

/**
 * The "My Drive" folder inside a Drive root: a known name, or else the only ordinary
 * folder besides the known other ones. `guess` = false accepts known names only.
 */
async function myDriveIn(drive: DriveEnv, root: string, guess: boolean): Promise<string | null> {
  const entries = await drive.readDir(root);
  if (!entries) return null;
  const folders = entries.filter(isOrdinaryFolder);
  const known = folders.find((entry) => MY_DRIVE.has(entry.name.toLowerCase()));
  const p = drive.platform === 'win32' ? path.win32 : path.posix;
  if (known) return p.join(root, known.name);
  if (!guess) return null;
  const rest = folders.filter((entry) => !OTHERS.has(entry.name.toLowerCase()));
  return rest.length === 1 ? p.join(root, rest[0]!.name) : null;
}

async function hasMarker(drive: DriveEnv, root: string): Promise<boolean> {
  const entries = await drive.readDir(root);
  return entries?.some((entry) => entry.name === DRIVE_MARKER) ?? false;
}

/** Drive letters that can hold Google Drive: A to C are left out. */
const WINDOWS_LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

async function windowsRoots(drive: DriveEnv): Promise<DriveRoot[]> {
  const p = path.win32;
  const found: DriveRoot[] = [];

  const letters = await Promise.all(
    WINDOWS_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`;
      // A data disk with a folder that happens to be called "My Drive" is not Google
      // Drive: the root must carry Drive's hidden marker folder.
      const marker = await hasMarker(drive, root);
      const myDrive = await myDriveIn(drive, root, marker);
      return myDrive && marker ? { path: myDrive, account: null } : null;
    }),
  );
  for (const root of letters) if (root) found.push(root);

  // Older clients and mirrored files live in the user folder.
  const legacy = p.join(drive.home, 'Google Drive');
  const inside = await myDriveIn(drive, legacy, false);
  if (inside) found.push({ path: inside, account: null });
  else if ((await drive.readDir(legacy)) !== null) found.push({ path: legacy, account: null });
  const mirrored = await myDriveIn(drive, drive.home, false);
  if (mirrored) found.push({ path: mirrored, account: null });
  return found;
}

async function macRoots(drive: DriveEnv): Promise<DriveRoot[]> {
  const p = path.posix;
  const found: DriveRoot[] = [];

  const cloudStorage = p.join(drive.home, 'Library', 'CloudStorage');
  for (const entry of (await drive.readDir(cloudStorage)) ?? []) {
    if (!entry.isDirectory || !entry.name.startsWith('GoogleDrive-')) continue;
    const myDrive = await myDriveIn(drive, p.join(cloudStorage, entry.name), true);
    const account = entry.name.slice('GoogleDrive-'.length);
    if (myDrive) found.push({ path: myDrive, account: account || null });
  }

  // Google Drive File Stream mounted a volume.
  for (const entry of (await drive.readDir('/Volumes')) ?? []) {
    if (!entry.isDirectory || !entry.name.startsWith('GoogleDrive')) continue;
    const myDrive = await myDriveIn(drive, p.join('/Volumes', entry.name), true);
    if (myDrive) found.push({ path: myDrive, account: null });
  }

  // Backup and Sync used ~/Google Drive as "My Drive" itself.
  const legacy = p.join(drive.home, 'Google Drive');
  const inside = await myDriveIn(drive, legacy, false);
  if (inside) found.push({ path: inside, account: null });
  else if ((await drive.readDir(legacy)) !== null) found.push({ path: legacy, account: null });
  return found;
}

/**
 * Every "My Drive" folder found on this machine, without duplicates. Several means
 * several accounts: the user then picks one.
 */
export async function findDriveRoots(drive: DriveEnv = currentDriveEnv()): Promise<DriveRoot[]> {
  const roots =
    drive.platform === 'win32'
      ? await windowsRoots(drive)
      : drive.platform === 'darwin'
        ? await macRoots(drive)
        : [];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = drive.platform === 'linux' ? root.path : root.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The volume labels of the Windows drive letters, which Google Drive sets to
 * `<account> - Google Drive`. Best effort: empty when they cannot be read.
 */
export function windowsVolumeLabels(): Promise<Map<string, string>> {
  if (process.platform !== 'win32') return Promise.resolve(new Map());
  const script =
    "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { try { $_.Name + '|' + $_.VolumeLabel } catch {} }";
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        const labels = new Map<string, string>();
        if (!error) {
          for (const line of stdout.split(/\r?\n/)) {
            const match = /^([A-Za-z]):\\\|(.+)$/.exec(line.trim());
            if (match) labels.set(match[1]!.toUpperCase(), match[2]!.trim());
          }
        }
        resolve(labels);
      },
    );
  });
}

/**
 * `alex@example.com - Google Drive` → `alex@example.com`. Windows keeps 32 characters of
 * a volume label, so the suffix is often cut: `alex@example.com - Goo...`.
 */
export function accountFromLabel(label: string): string | null {
  const separator = label.lastIndexOf(' - ');
  if (separator <= 0) return null;
  const suffix = label
    .slice(separator + 3)
    .replace(/(\.\.\.|…)\s*$/, '')
    .trim()
    .toLowerCase();
  if (suffix === '' || !'google drive'.startsWith(suffix)) return null;
  return label.slice(0, separator).trim() || null;
}

/** The sync folder meant by a folder the user picked: the app's own folder inside it. */
export function syncFolderFromPick(picked: string, folderName: string): string {
  const p = process.platform === 'win32' ? path.win32 : path.posix;
  const clean = picked.length > 1 ? picked.replace(/[\\/]+$/, '') : picked;
  return p.basename(clean) === folderName ? clean : p.join(clean, folderName);
}
