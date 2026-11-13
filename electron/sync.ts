/**
 * Sync through Google Drive for desktop: this machine writes its own aggregates to
 * `<My Drive>/ClaudeTokenTracker/machines/<machineId>/`, and reads every other machine's
 * folder. No Google API: only files in the local synced folder are read and written.
 *
 * - Each machine is the only writer of its folder, so writes never conflict.
 * - Writes are atomic (`2026.json.tmp`, then a rename), only for the years whose content
 *   changed, 60 s after a scan that changed something and at most every 5 minutes, plus
 *   on quit. `machine.json` is rewritten at least every hour, as a heartbeat.
 * - Other machines' folders are listed every 30 s. A file that cannot be parsed (Drive may
 *   still be downloading it) is skipped and the last good copy is kept; Drive conflict
 *   copies (`2026 (1).json`) are ignored and logged.
 * - Other machines' rows replace their previous ones in the derived tables, under their
 *   own machine id. This machine's rows always come from its own logs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { aliasMap } from '../shared/projects';
import type { DriveCandidate, Platform, SyncMachine, SyncStatus } from '../shared/types';
import type { UsageDatabase } from './db';
import { accountFromLabel, findDriveRoots, windowsVolumeLabels, type DriveRoot } from './drive';
import { tildify } from './paths';
import {
  buildYearFiles,
  classifySyncFile,
  GZIP_THRESHOLD,
  isMachineId,
  MACHINE_FILE,
  MACHINES_FOLDER,
  MAX_SYNC_FILE_BYTES,
  parseMachineFile,
  parseYearFile,
  README_FILE,
  README_TEXT,
  recordsFromYearFiles,
  serializeMachineFile,
  serializeYearFile,
  SYNC_FOLDER_NAME,
  SYNC_SCHEMA_VERSION,
  type ParseFailure,
  type YearFile,
} from './syncFormat';

/** Wait after a change before writing, so a burst of changes gives one write. */
export const EXPORT_DEBOUNCE_MS = 60_000;
/** Shortest time between two writes. */
export const EXPORT_MIN_INTERVAL_MS = 5 * 60_000;
/** How often other machines' folders are read. */
export const READ_INTERVAL_MS = 30_000;
/** `machine.json` is rewritten at least this often, so other machines see this one is alive. */
export const HEARTBEAT_MS = 60 * 60_000;
/** Drive folders found are reused for this long before looking again. */
const DETECTION_TTL_MS = 60_000;

const SETTING_ENABLED = 'sync_enabled';
const SETTING_FOLDER = 'sync_folder';
const SETTING_PICKED = 'sync_folder_picked';
const SETTING_WRITTEN = 'sync_written';

/** What the main process gives the sync. */
export interface SyncHost {
  database(): UsageDatabase | null;
  appVersion: string;
  platform: Platform;
  /** Runs a task after the database tasks queued before it (scans, rebuilds). */
  serial<T>(task: () => T | Promise<T>): Promise<T>;
  /** Other machines' usage changed: the pages must refresh. */
  onDataChanged(): void;
  /** The sync status changed (title bar, Settings). */
  onStatusChanged(): void;
  now?(): number;
}

/** What was last written, to rewrite only what changed. */
interface WrittenState {
  folder: string;
  name: string;
  /** SHA-1 of each year file's text. */
  years: Record<string, string>;
}

/** Reads a stored JSON setting, or null when it is missing or malformed. */
function readWritten(db: UsageDatabase): WrittenState | null {
  try {
    const value = JSON.parse(db.getSetting(SETTING_WRITTEN) ?? 'null') as WrittenState | null;
    return value && typeof value.folder === 'string' && typeof value.years === 'object'
      ? value
      : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return error instanceof Error ? error.message : 'unknown error';
}

function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Writes through a temporary file renamed over the target, so readers never see half a file. */
export function writeAtomic(target: string, data: string | Buffer): void {
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      // Drive or an antivirus can hold the target open for a moment on Windows.
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error));
      if (busy && attempt < 4) continue;
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

const signature = (stat: { size: number; mtimeMs: number }) => `${stat.size}:${stat.mtimeMs}`;

export class SyncService {
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
  private readTimer: ReturnType<typeof setInterval> | null = null;
  private lastWriteAt = 0;
  private reading = false;
  /** Null until the first read or write: then whether the folder could be reached. */
  private reachable: boolean | null = null;
  /** The last write failed (Drive not mounted yet, say): write again once it is reachable. */
  private writeFailed = false;
  private problems = new Map<string, NonNullable<SyncMachine['problem']>>();
  private conflicts = new Map<string, Set<string>>();
  /** Files already found unreadable, by `<machine>/<file>` and signature, to log them once. */
  private failed = new Map<string, string>();
  private machineFiles = new Map<string, string>();
  private detection: { at: number; roots: DriveCandidate[] } | null = null;

  constructor(private readonly host: SyncHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  get enabled(): boolean {
    return this.host.database()?.getSetting(SETTING_ENABLED) === '1';
  }

  /** The `ClaudeTokenTracker` folder, or null when none is set. */
  get folder(): string | null {
    return this.host.database()?.getSetting(SETTING_FOLDER) || null;
  }

  get folderPicked(): boolean {
    return this.host.database()?.getSetting(SETTING_PICKED) === '1';
  }

  /**
   * Turns sync on or off. Turning it on without a folder looks for Google Drive and
   * uses the folder found when there is exactly one.
   */
  async setEnabled(on: boolean, findRoots = () => this.candidates(true)): Promise<void> {
    const db = this.host.database();
    if (!db) return;
    db.setSetting(SETTING_ENABLED, on ? '1' : '0');
    if (!on) {
      this.stop();
      this.reachable = null;
      this.host.onStatusChanged();
      return;
    }
    if (!this.folder) {
      const roots = await findRoots();
      if (roots.length === 1) this.setFolder(path.join(roots[0]!.path, SYNC_FOLDER_NAME), false);
    }
    this.start();
    await this.syncNow();
  }

  /** Uses `folder` (a `ClaudeTokenTracker` folder) from now on. */
  setFolder(folder: string, picked: boolean): void {
    const db = this.host.database();
    if (!db) return;
    db.setSetting(SETTING_FOLDER, folder);
    db.setSetting(SETTING_PICKED, picked ? '1' : '0');
    this.reachable = null;
    this.problems.clear();
    this.conflicts.clear();
    this.failed.clear();
    this.machineFiles.clear();
    this.host.onStatusChanged();
  }

  /** The Google Drive "My Drive" folders of this machine, cached for a minute. */
  async candidates(fresh = false): Promise<DriveCandidate[]> {
    if (!fresh && this.detection && this.now() - this.detection.at < DETECTION_TTL_MS) {
      return this.detection.roots;
    }
    const roots: DriveRoot[] = await findDriveRoots();
    // Several accounts on Windows: the volume labels tell them apart.
    const labels = roots.length > 1 ? await windowsVolumeLabels() : new Map<string, string>();
    const found = roots.map((root) => {
      const letter = /^([A-Za-z]):\\/.exec(root.path)?.[1]?.toUpperCase();
      const label = letter ? labels.get(letter) : undefined;
      return {
        path: root.path,
        display: tildify(root.path),
        account: root.account ?? (label ? accountFromLabel(label) : null),
      };
    });
    this.detection = { at: this.now(), roots: found };
    return found;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Starts reading other machines every 30 s, when sync is on. */
  start(): void {
    if (!this.enabled || this.readTimer) return;
    this.readTimer = setInterval(() => void this.readNow(), READ_INTERVAL_MS);
  }

  stop(): void {
    if (this.readTimer) clearInterval(this.readTimer);
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.readTimer = null;
    this.exportTimer = null;
  }

  /** Writes what is pending before the app quits. Synchronous: the database closes next. */
  flushOnQuit(): void {
    const pending = this.exportTimer !== null;
    this.stop();
    if (pending) this.writeOwnFiles(false);
  }

  /**
   * This machine's usage changed. The write waits 60 s, so that a burst of changes gives
   * one write, and comes at least 5 minutes after the previous one. Later changes do not
   * push it back: the write sees them anyway.
   */
  localDataChanged(): void {
    if (!this.enabled || !this.folder || this.exportTimer) return;
    const due = Math.max(
      this.now() + EXPORT_DEBOUNCE_MS,
      this.lastWriteAt + EXPORT_MIN_INTERVAL_MS,
    );
    this.exportTimer = setTimeout(() => {
      this.exportTimer = null;
      void this.host.serial(() => this.writeOwnFiles(false));
    }, due - this.now());
  }

  /** Writes this machine's files and reads the others' now. */
  async syncNow(): Promise<void> {
    if (!this.enabled || !this.folder) return;
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.exportTimer = null;
    await this.host.serial(() => this.writeOwnFiles(true));
    await this.readNow();
  }

  // ── Writing ─────────────────────────────────────────────────────────────────

  /**
   * Writes the year files whose content changed, then `machine.json` when something was
   * written, the name changed, `force` is set, or the last write is an hour old.
   * Returns false when the folder could not be written.
   */
  writeOwnFiles(force: boolean): boolean {
    const db = this.host.database();
    const folder = this.folder;
    if (!db || !folder || !this.enabled) return false;

    // The Drive folder must exist: creating it would make a local folder Drive never syncs.
    const driveRoot = path.dirname(folder);
    if (!exists(driveRoot)) return this.writeFailedNow();

    try {
      const machineDir = path.join(folder, MACHINES_FOLDER, db.machineId);
      fs.mkdirSync(machineDir, { recursive: true });
      const readme = path.join(folder, README_FILE);
      if (!exists(readme)) fs.writeFileSync(readme, README_TEXT.replace(/\n/g, '\r\n'));

      const previous = readWritten(db);
      const written: WrittenState = {
        folder,
        name: db.machineName,
        years: previous?.folder === folder ? { ...previous.years } : {},
      };
      const files = buildYearFiles(db.exportRecords(), db.machineId);
      let changed = false;
      for (const [year, file] of files) {
        changed = this.writeYear(machineDir, year, file, written) || changed;
      }

      const now = this.now();
      const lastSync = db.listAllMachines().find((machine) => machine.isLocal)?.lastSync;
      const heartbeat = !lastSync || now - Date.parse(lastSync) >= HEARTBEAT_MS;
      if (changed || force || heartbeat || previous?.name !== written.name) {
        const at = new Date(now).toISOString();
        writeAtomic(
          path.join(machineDir, MACHINE_FILE),
          serializeMachineFile({
            schemaVersion: SYNC_SCHEMA_VERSION,
            machineId: db.machineId,
            name: written.name,
            platform: this.host.platform,
            appVersion: this.host.appVersion,
            lastSync: at,
            years: [...files.keys()].sort(),
          }),
        );
        db.setLocalLastSync(at);
        this.host.onStatusChanged();
      }
      db.setSetting(SETTING_WRITTEN, JSON.stringify(written));
      this.lastWriteAt = now;
      this.writeFailed = false;
      return this.markReachable(true);
    } catch (error) {
      console.warn(`[sync] Could not write the sync files: ${errorCode(error)}`);
      return this.writeFailedNow();
    }
  }

  private writeFailedNow(): boolean {
    this.writeFailed = true;
    return this.markReachable(false);
  }

  /** Writes one year when its text changed or its file is missing. True when written. */
  private writeYear(dir: string, year: number, file: YearFile, written: WrittenState): boolean {
    const text = serializeYearFile(file);
    const hash = sha1(text);
    const gzip = Buffer.byteLength(text) > GZIP_THRESHOLD;
    const name = `${year}.json${gzip ? '.gz' : ''}`;
    const other = `${year}.json${gzip ? '' : '.gz'}`;
    const target = path.join(dir, name);
    if (written.years[year] === hash && exists(target)) return false;

    writeAtomic(target, gzip ? gzipSync(text) : text);
    fs.rmSync(path.join(dir, other), { force: true });
    written.years[year] = hash;
    return true;
  }

  private markReachable(reachable: boolean): boolean {
    if (this.reachable !== reachable) {
      this.reachable = reachable;
      if (!reachable) console.warn('[sync] The sync folder cannot be reached: sync is pending.');
      this.host.onStatusChanged();
    }
    // Launched at login, the app can start before Google Drive has mounted its folder: the
    // write that failed then is scheduled again as soon as a read finds the folder.
    if (reachable && this.writeFailed) this.localDataChanged();
    return reachable;
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  /** Reads the other machines' folders once. Overlapping calls are merged. */
  async readNow(): Promise<void> {
    if (this.reading || !this.enabled || !this.folder) return;
    this.reading = true;
    try {
      await this.readOnce();
    } catch (error) {
      console.warn(`[sync] Could not read the sync folder: ${errorCode(error)}`);
    } finally {
      this.reading = false;
    }
    // A machine that has been idle still tells the others it is alive.
    const db = this.host.database();
    const lastSync = db?.listAllMachines().find((machine) => machine.isLocal)?.lastSync;
    if (db && (!lastSync || this.now() - Date.parse(lastSync) >= HEARTBEAT_MS)) {
      this.localDataChanged();
    }
  }

  private async readOnce(): Promise<void> {
    const db = this.host.database();
    const folder = this.folder;
    if (!db || !folder) return;

    const machinesDir = path.join(folder, MACHINES_FOLDER);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(machinesDir, { withFileTypes: true });
    } catch {
      // Nothing written yet is fine; a missing Drive folder is not.
      this.markReachable(exists(path.dirname(folder)));
      return;
    }

    const seen = new Set<string>();
    let dataChanged = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || !isMachineId(entry.name) || entry.name === db.machineId) continue;
      seen.add(entry.name);
      if (db.isMachineHidden(entry.name)) continue;
      dataChanged =
        (await this.readMachine(db, path.join(machinesDir, entry.name), entry.name)) || dataChanged;
    }

    for (const machine of db.listAllMachines()) {
      if (machine.isLocal || machine.hidden) continue;
      if (!seen.has(machine.id)) this.problems.set(machine.id, 'missing');
      else if (this.problems.get(machine.id) === 'missing') this.problems.delete(machine.id);
    }
    this.markReachable(true);
    if (dataChanged) this.host.onDataChanged();
  }

  /** Reads one machine's folder. True when its usage changed. */
  private async readMachine(db: UsageDatabase, dir: string, id: string): Promise<boolean> {
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    const conflicts = new Set<string>();
    const years = new Map<number, { name: string; size: number; mtimeMs: number }>();
    let machineStat: { size: number; mtimeMs: number } | null = null;

    for (const name of names) {
      const kind = classifySyncFile(name);
      if (kind.kind === 'ignored') continue;
      if (kind.kind === 'conflict') {
        conflicts.add(name);
        if (!this.conflicts.get(id)?.has(name)) {
          console.warn(`[sync] Ignored the Drive conflict copy ${id}/${name}`);
        }
        continue;
      }
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      if (kind.kind === 'machine') {
        machineStat = stat;
        continue;
      }
      // `2026.json` and `2026.json.gz` both present: the newer one wins.
      const known = years.get(kind.year);
      if (!known || stat.mtimeMs > known.mtimeMs) {
        years.set(kind.year, { name, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    this.conflicts.set(id, conflicts);

    let problem: SyncMachine['problem'] = null;
    if (machineStat && this.machineFiles.get(id) !== signature(machineStat)) {
      const text = await this.readText(path.join(dir, MACHINE_FILE), machineStat.size);
      const parsed = text === null ? null : parseMachineFile(text, id);
      if (parsed?.ok) {
        const machine = parsed.value;
        await this.host.serial(() =>
          db.upsertRemoteMachine({
            id,
            name: machine.name,
            platform: machine.platform,
            lastSync: machine.lastSync,
            appVersion: machine.appVersion || null,
          }),
        );
        this.machineFiles.set(id, signature(machineStat));
        this.host.onStatusChanged();
      } else {
        problem = this.failure(id, MACHINE_FILE, machineStat, parsed ? parsed.reason : 'json');
      }
    }
    // Without a machine.json read once, there is no name to show: wait for it.
    if (!db.listAllMachines().some((machine) => machine.id === id)) {
      this.setProblem(id, problem);
      return false;
    }

    const stored = db.remoteFileStates();
    const updates: {
      year: number;
      name: string;
      size: number;
      mtimeMs: number;
      content: string;
    }[] = [];
    for (const [year, file] of years) {
      const known = stored.get(`${id}/${year}`);
      if (
        known &&
        known.file === file.name &&
        known.size === file.size &&
        known.mtimeMs === file.mtimeMs
      ) {
        continue;
      }
      const key = `${id}/${file.name}`;
      if (this.failed.get(key) === signature(file)) {
        problem ??= 'unreadable';
        continue;
      }
      const text = await this.readText(
        path.join(dir, file.name),
        file.size,
        file.name.endsWith('.gz'),
      );
      const parsed = text === null ? null : parseYearFile(text, id, year);
      if (parsed?.ok) {
        this.failed.delete(key);
        if (parsed.skippedRows > 0) {
          console.warn(`[sync] Skipped ${parsed.skippedRows} malformed row(s) in ${key}`);
        }
        updates.push({ year, ...file, content: text! });
      } else {
        problem = this.failure(id, file.name, file, parsed ? parsed.reason : 'json') ?? problem;
      }
    }
    this.setProblem(id, problem);
    if (updates.length === 0) return false;

    await this.host.serial(() => {
      for (const update of updates) {
        db.saveRemoteFile({
          machineId: id,
          year: update.year,
          file: update.name,
          size: update.size,
          mtimeMs: update.mtimeMs,
          content: update.content,
        });
      }
      this.materialize(db, id);
    });
    console.log(`[sync] Read ${updates.length} file(s) of machine ${id}`);
    return true;
  }

  /** The text of a sync file, or null when it cannot be read (yet). */
  private async readText(file: string, size: number, gzip = false): Promise<string | null> {
    if (size > MAX_SYNC_FILE_BYTES) return null;
    try {
      const data = await fs.promises.readFile(file);
      return (gzip ? gunzipSync(data, { maxOutputLength: MAX_SYNC_FILE_BYTES }) : data).toString(
        'utf8',
      );
    } catch {
      return null;
    }
  }

  /** Remembers a file that could not be used, and says why once. */
  private failure(
    id: string,
    name: string,
    stat: { size: number; mtimeMs: number },
    reason: ParseFailure,
  ): SyncMachine['problem'] {
    const key = `${id}/${name}`;
    if (this.failed.get(key) !== signature(stat)) {
      this.failed.set(key, signature(stat));
      console.warn(`[sync] Kept the last good copy of ${key}: ${reason}`);
    }
    return reason === 'newerVersion' ? 'newerVersion' : 'unreadable';
  }

  private setProblem(id: string, problem: SyncMachine['problem']): void {
    if (problem) this.problems.set(id, problem);
    else this.problems.delete(id);
  }

  /**
   * Rebuilds another machine's rows from its stored year files, with the current aliases.
   * Runs on the task chain.
   */
  materialize(db: UsageDatabase, machineId: string): void {
    if (db.isMachineHidden(machineId)) return;
    const files: YearFile[] = [];
    for (const stored of db.remoteFiles(machineId)) {
      const parsed = parseYearFile(stored.content, machineId, stored.year);
      if (parsed.ok) files.push(parsed.value);
    }
    db.replaceMachineRecords(
      machineId,
      recordsFromYearFiles(files, aliasMap(db.getProjectAliases())),
    );
  }

  /** Rebuilds every other machine's rows, after the aliases changed. Runs on the chain. */
  materializeAll(db: UsageDatabase): void {
    for (const machine of db.listAllMachines()) {
      if (!machine.isLocal && !machine.hidden) this.materialize(db, machine.id);
    }
  }

  /** Hides another machine; with `deleteFiles`, also deletes its folder from the sync folder. */
  async hideMachine(machineId: string, deleteFiles: boolean): Promise<void> {
    const db = this.host.database();
    if (!db || machineId === db.machineId || !isMachineId(machineId)) return;
    await this.host.serial(() => db.setMachineHidden(machineId, true));
    this.problems.delete(machineId);
    const folder = this.folder;
    if (deleteFiles && folder) {
      await fs.promises.rm(path.join(folder, MACHINES_FOLDER, machineId), {
        recursive: true,
        force: true,
      });
      console.log(`[sync] Deleted the sync files of machine ${machineId}`);
    }
    this.host.onDataChanged();
  }

  async restoreMachine(machineId: string): Promise<void> {
    const db = this.host.database();
    if (!db || !isMachineId(machineId)) return;
    await this.host.serial(() => {
      db.setMachineHidden(machineId, false);
      this.materialize(db, machineId);
    });
    // Its machine.json is read again by the next poll, which also picks up newer files.
    this.machineFiles.delete(machineId);
    this.host.onDataChanged();
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  status(): SyncStatus {
    const db = this.host.database();
    const machines = db?.listMachines() ?? [];
    const folder = this.folder;
    const enabled = this.enabled;
    return {
      enabled,
      state: !enabled
        ? 'off'
        : !folder
          ? 'needsFolder'
          : this.reachable === false
            ? 'pending'
            : 'synced',
      machines: machines.length,
      lastSync: machines.find((machine) => machine.isLocal)?.lastSync ?? null,
      folder: folder ? tildify(folder) : null,
    };
  }

  /** Every machine with what the sync knows about it, for Settings. */
  machines(): SyncMachine[] {
    const db = this.host.database();
    return (db?.listAllMachines() ?? []).map((machine) => ({
      ...machine,
      problem: machine.isLocal ? null : (this.problems.get(machine.id) ?? null),
      conflictCopies: this.conflicts.get(machine.id)?.size ?? 0,
    }));
  }
}
