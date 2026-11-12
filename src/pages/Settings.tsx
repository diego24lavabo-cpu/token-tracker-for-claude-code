import { ArrowRight, ChevronDown, FolderPlus, Info, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { aliasProblem } from '../../shared/projects';
import { staleDays } from '../../shared/sync';
import type {
  CsvKind,
  Pricing,
  ProjectAlias,
  SettingsData,
  SyncMachine,
  SyncStatus,
} from '../../shared/types';
import { MachineIcon } from '../components/MachineIcon';
import { Page } from '../components/Page';
import { PricingEditor } from '../components/PricingEditor';
import { Switch } from '../components/Switch';
import { useNow } from '../hooks/useNow';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import {
  formatBytes,
  formatDuration,
  formatInt,
  formatPercent,
  formatTimeAgo,
} from '../lib/format';

const t = en.settings;
const NO_VALUE = '—';
const CSV_KINDS: readonly CsvKind[] = ['daily', 'projects', 'models', 'agentTypes'];
/** How long a confirmation message stays under its button. */
const STATUS_MS = 8_000;

export function Settings() {
  const fetchSettings = useCallback(() => window.api.getSettings(), []);
  const { data } = useUsageQuery(fetchSettings, { syncStatus: true });
  const disabled = !data?.available;

  return (
    <Page section="settings">
      {data && !data.available && <p className="settings-notice">{t.unavailable}</p>}
      <div className="settings-columns">
        <SourcesCard data={data} disabled={disabled} />
        <SyncCard data={data} disabled={disabled} />
        <AppCard data={data} disabled={disabled} />
        <ContainersCard data={data} disabled={disabled} />
        <AliasesCard data={data} disabled={disabled} />
      </div>
      <PricingCard data={data} disabled={disabled} />
    </Page>
  );
}

// ── Building blocks ───────────────────────────────────────────────────────────

function SettingsCard({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card settings-card${className ? ` ${className}` : ''}`}>
      <header className="settings-card-header">
        <h2 className="card-title">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  stacked,
  children,
}: {
  label: ReactNode;
  hint?: string;
  /** Puts the value under the label, for a row of buttons. */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`settings-row${stacked ? ' settings-row--stacked' : ''}`}>
      <div className="settings-label">
        {label}
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      <div className="settings-value">{children}</div>
    </div>
  );
}

/** A short message after an action; it fades out by itself. */
function useStatus(): [string | null, (message: string | null) => void] {
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return [status, setStatus];
}

function Status({ message }: { message: string | null }) {
  return (
    <p className="settings-status" role="status">
      {message}
    </p>
  );
}

// ── Data sources ──────────────────────────────────────────────────────────────

function SourcesCard({ data, disabled }: { data: SettingsData | null; disabled: boolean }) {
  const s = t.sources;
  const now = useNow();
  const [busy, setBusy] = useState<'add' | 'scan' | 'retention' | null>(null);
  const [status, setStatus] = useStatus();
  const sources = data?.sources;
  const retention = data?.retention;

  const run = async (action: 'add' | 'scan' | 'retention', task: () => Promise<string | null>) => {
    setBusy(action);
    try {
      setStatus(await task());
    } catch (error) {
      console.error('Settings action failed', error);
      setStatus(t.app.actionFailed);
    } finally {
      setBusy(null);
    }
  };

  const addFolder = () =>
    run('add', async () => {
      const result = await window.api.addLogFolder();
      if (result.status === 'added') return s.folderAdded(result.folder);
      if (result.status === 'exists') return s.folderExists(result.folder);
      return null;
    });

  const keepLonger = (days: number) =>
    run('retention', async () => {
      const result = await window.api.keepHistoryLonger(days);
      if (result.status === 'done') return s.keepLongerDone;
      return result.status === 'failed' ? t.app.actionFailed : null;
    });

  // The choice made in the menu, as long as it is still offered.
  const [picked, setPicked] = useState<number | null>(null);
  const choices = retention?.choices ?? [];
  const chosen =
    picked !== null && choices.includes(picked) ? picked : (retention?.defaultChoice ?? null);
  const canRaise = retention !== undefined && retention.readable && chosen !== null;

  return (
    <SettingsCard title={s.title}>
      <div className="settings-block">
        <span className="settings-label">{s.folders}</span>
        <ul className="folder-list">
          {sources?.folders.map((folder) => (
            <li key={folder.path} className="folder-item">
              <span className="folder-path num" title={folder.path}>
                {folder.display}
              </span>
              <span className="folder-meta">
                {!folder.auto && <span className="kind-badge">{s.added}</span>}
                {folder.exists ? (
                  <span className="num">{s.files(folder.files, formatInt(folder.files))}</span>
                ) : (
                  <span className="cell-accent">{s.notFound}</span>
                )}
              </span>
              {!folder.auto && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={s.remove(folder.display)}
                  title={s.remove(folder.display)}
                  disabled={disabled}
                  onClick={() => void window.api.removeLogFolder(folder.path)}
                >
                  <X size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            disabled={disabled || busy !== null}
            onClick={() => void addFolder()}
          >
            <FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
            {s.addFolder}
          </button>
        </div>
      </div>

      <div className="settings-rows">
        <Row label={s.filesScanned}>
          <span className="num">{sources ? formatInt(sources.filesScanned) : NO_VALUE}</span>
        </Row>
        <Row label={s.subagentFiles}>
          <span className="num">{sources ? formatInt(sources.subagentFiles) : NO_VALUE}</span>
        </Row>
        <Row label={s.skippedLines}>
          {sources && sources.skippedLines > 0 ? (
            <span className="warning-badge num" title={s.skippedHint}>
              {s.skippedBadge(formatInt(sources.skippedLines))}
            </span>
          ) : (
            <span className="num">{sources ? '0' : NO_VALUE}</span>
          )}
        </Row>
        <Row label={s.databaseSize}>
          <span className="num">
            {sources?.databaseBytes != null ? formatBytes(sources.databaseBytes) : NO_VALUE}
          </span>
        </Row>
        <Row label={s.lastScan}>
          <span className="settings-inline">
            <span className="num">
              {busy === 'scan'
                ? s.scanning
                : sources?.lastScan
                  ? `${formatTimeAgo(sources.lastScan.at, now)} · ${s.scanTook(formatDuration(sources.lastScan.durationMs))}`
                  : s.never}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={s.scanNow}
              title={s.scanNow}
              disabled={disabled || busy !== null}
              onClick={() =>
                void run('scan', async () => {
                  await window.api.scanNow();
                  return null;
                })
              }
            >
              <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
        </Row>
        <Row label={s.retention}>
          <span className="num">
            {!retention
              ? NO_VALUE
              : !retention.readable
                ? s.retentionUnreadable
                : retention.cleanupPeriodDays === null
                  ? `${s.retentionDays(retention.defaultDays)} (${s.retentionDefault})`
                  : s.retentionDays(retention.cleanupPeriodDays)}
          </span>
        </Row>
      </div>

      {retention && (
        <div className="settings-block">
          <p className="settings-hint">{s.retentionHint(retention.settingsFile)}</p>
          {canRaise && (
            <div className="settings-actions">
              <label className="select-field">
                <span className="select-field-label">{s.keepLongerFor}</span>
                <select
                  value={chosen}
                  disabled={disabled || busy !== null}
                  onChange={(event) => setPicked(Number(event.target.value))}
                >
                  {choices.map((days) => (
                    <option key={days} value={days}>
                      {s.retentionDays(days)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
              </label>
              <button
                type="button"
                className="button"
                disabled={disabled || busy !== null}
                onClick={() => void keepLonger(chosen)}
              >
                {s.keepLonger}
              </button>
            </div>
          )}
        </div>
      )}
      <Status message={status} />
    </SettingsCard>
  );
}

// ── Container folders ─────────────────────────────────────────────────────────

function ContainersCard({ data, disabled }: { data: SettingsData | null; disabled: boolean }) {
  const c = t.containers;
  // The flags as last asked for, shown while the tables are being rebuilt.
  const [pending, setPending] = useState<string[] | null>(null);
  const candidates = data?.containers ?? [];
  const flagged = pending ?? candidates.filter((item) => item.flagged).map((item) => item.name);

  const toggle = async (name: string, on: boolean) => {
    const next = on ? [...flagged, name] : flagged.filter((item) => item !== name);
    setPending(next);
    try {
      await window.api.setSettings({ containerProjects: next });
    } catch (error) {
      console.error('Could not change the container folders', error);
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsCard
      title={c.title}
      aside={pending ? <span className="settings-hint">{c.applying}</span> : undefined}
    >
      <p className="settings-hint">{c.hint}</p>
      {data && candidates.length === 0 ? (
        <p className="settings-empty">{c.empty}</p>
      ) : (
        <ul className="container-list">
          {candidates.map((item) => {
            const on = flagged.includes(item.name);
            return (
              <li key={item.name} className="container-item">
                <div className="container-text">
                  <span className="container-name">{item.name}</span>
                  <span className="settings-hint">
                    {c.subfolders(item.subfolderCount)}
                    {item.topSubfolders.length > 0 && ` · ${item.topSubfolders.join(', ')}`}
                    {item.subfolderCount > item.topSubfolders.length && ', …'}
                  </span>
                  <span className="settings-hint num">
                    {c.inSubfolders(
                      item.subfolderShare > 0 && item.subfolderShare < 0.0005
                        ? '<0.1%'
                        : formatPercent(item.subfolderShare),
                    )}
                  </span>
                </div>
                <Switch
                  label={c.toggle(item.name)}
                  checked={on}
                  disabled={disabled || pending !== null}
                  onChange={(checked) => void toggle(item.name, checked)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </SettingsCard>
  );
}

// ── Sync ──────────────────────────────────────────────────────────────────────

function syncStatusText(status: SyncStatus, now: number): string {
  const s = t.sync;
  if (!status.enabled) return s.statusOff;
  if (status.state === 'needsFolder') return s.statusNeedsFolder;
  if (status.state === 'pending') return s.statusPending;
  return status.lastSync ? s.statusSynced(formatTimeAgo(status.lastSync, now)) : s.statusNotYet;
}

function machineDetail(machine: SyncMachine, now: number): string {
  const s = t.sync;
  const parts: string[] = [en.platforms[machine.platform]];
  const stale = machine.isLocal ? null : staleDays(machine.lastSync, now);
  if (stale !== null) parts.push(s.stale(stale));
  else
    parts.push(
      machine.lastSync ? s.syncedAgo(formatTimeAgo(machine.lastSync, now)) : s.neverSynced,
    );
  if (machine.problem) parts.push(s.problems[machine.problem]);
  if (machine.conflictCopies > 0) parts.push(s.conflicts(machine.conflictCopies));
  return parts.join(' · ');
}

function SyncCard({ data, disabled }: { data: SettingsData | null; disabled: boolean }) {
  const s = t.sync;
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useStatus();
  // The name being typed; null while it is the saved one.
  const [name, setName] = useState<string | null>(null);
  const sync = data?.sync;
  const status = sync?.status;
  const enabled = status?.enabled ?? false;
  const candidates = sync?.candidates ?? [];

  const run = async (key: string, task: () => Promise<string | null>) => {
    setBusy(key);
    try {
      setMessage(await task());
    } catch (error) {
      console.error('Sync action failed', error);
      setMessage(t.app.actionFailed);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (on: boolean) =>
    run('toggle', async () => {
      await window.api.setSettings({ syncEnabled: on });
      return null;
    });
  const choose = () =>
    run('choose', async () => {
      await window.api.chooseSyncFolder();
      return null;
    });
  const use = (folder: string) =>
    run('use', async () => {
      await window.api.useSyncFolder(folder);
      return null;
    });
  const syncNow = () =>
    run('sync', async () => {
      await window.api.syncNow();
      return s.synced;
    });
  const saveName = (value: string) =>
    run('name', async () => {
      await window.api.setSettings({ machineName: value });
      setName(null);
      return s.saved;
    });
  const remove = (machineId: string) =>
    run('remove', async () => {
      const result = await window.api.removeMachine(machineId);
      return result.status === 'failed' ? t.app.actionFailed : null;
    });
  const restore = (machineId: string) =>
    run('restore', async () => {
      await window.api.restoreMachine(machineId);
      return null;
    });

  const typed = name?.trim() ?? '';
  const nameChanged = name !== null && typed !== '' && typed !== sync?.machineName;
  const machines = sync?.machines ?? [];
  const currentRoot = status?.folder ?? null;

  return (
    <SettingsCard
      title={s.title}
      aside={
        <Switch
          label={s.toggle}
          checked={enabled}
          disabled={disabled || !sync || busy !== null}
          onChange={(on) => void toggle(on)}
        />
      }
    >
      <p className="settings-hint">{s.explain}</p>
      <div className="sync-what">
        <span className="settings-label">{s.whatTitle}</span>
        <p className="settings-hint">{s.what}</p>
        <p className="settings-hint sync-never">{s.never}</p>
      </div>

      <div className="settings-rows">
        <Row label={s.status} hint={status?.state === 'pending' ? s.statusPendingHint : undefined}>
          <span className={`sync-state sync-state--${status?.state ?? 'off'}`}>
            {status ? syncStatusText(status, now) : NO_VALUE}
          </span>
        </Row>
        {enabled && (
          <Row label={s.folder} hint={sync?.folderPicked ? s.folderPicked : undefined}>
            <span className="settings-inline sync-folder">
              {currentRoot && (
                <span className="num settings-path" title={currentRoot}>
                  {currentRoot}
                </span>
              )}
              <button
                type="button"
                className="button button--small"
                disabled={disabled || busy !== null}
                onClick={() => void choose()}
              >
                {currentRoot ? s.change : s.chooseFolder}
              </button>
            </span>
          </Row>
        )}
      </div>

      {enabled && candidates.length > 1 && (
        <div className="settings-block">
          <p className="settings-hint">
            {status?.state === 'needsFolder' ? s.severalFound : s.accountsFound}
          </p>
          <ul className="folder-list">
            {candidates.map((candidate) => {
              const current = currentRoot?.startsWith(candidate.display) ?? false;
              return (
                <li key={candidate.path}>
                  <button
                    type="button"
                    className={`folder-item sync-candidate${current ? ' is-current' : ''}`}
                    aria-pressed={current}
                    aria-label={s.useCandidate(candidate.display)}
                    disabled={disabled || busy !== null}
                    onClick={() => void use(candidate.path)}
                  >
                    <span className="folder-path num">{candidate.display}</span>
                    {candidate.account && <span className="folder-meta">{candidate.account}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {enabled && status?.state === 'needsFolder' && candidates.length === 0 && (
        <p className="settings-hint">{s.noneFound}</p>
      )}

      <div className="settings-rows">
        <Row label={s.machineName} hint={s.machineNameHint}>
          <form
            className="settings-inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (nameChanged) void saveName(typed);
            }}
          >
            <input
              className="text-field"
              value={name ?? sync?.machineName ?? ''}
              maxLength={60}
              aria-label={s.machineName}
              disabled={disabled || !sync}
              onChange={(event) => setName(event.target.value)}
            />
            {nameChanged && (
              <button type="submit" className="button button--small" disabled={busy !== null}>
                {s.save}
              </button>
            )}
          </form>
        </Row>
      </div>

      <div className="settings-block">
        <span className="settings-label">{s.knownMachines}</span>
        <ul className="container-list">
          {machines.map((machine) => (
            <li
              key={machine.id}
              className={`container-item sync-machine${machine.hidden ? ' is-hidden' : ''}`}
            >
              <span className="sync-machine-icon">
                <MachineIcon platform={machine.platform} />
              </span>
              <div className="container-text">
                <span className="container-name">
                  {machine.name}
                  {machine.isLocal && <span className="settings-hint"> · {s.thisMachine}</span>}
                  {machine.hidden && <span className="kind-badge">{s.hidden}</span>}
                </span>
                <span
                  className={`settings-hint${machine.problem || staleDays(machine.lastSync, now) !== null ? ' sync-warning' : ''}`}
                >
                  {machineDetail(machine, now)}
                </span>
              </div>
              {!machine.isLocal &&
                (machine.hidden ? (
                  <button
                    type="button"
                    className="button button--small"
                    disabled={disabled || busy !== null}
                    onClick={() => void restore(machine.id)}
                  >
                    {s.restore}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={s.remove(machine.name)}
                    title={s.remove(machine.name)}
                    disabled={disabled || busy !== null}
                    onClick={() => void remove(machine.id)}
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                ))}
            </li>
          ))}
        </ul>
        {enabled && machines.length <= 1 && <p className="settings-hint">{s.noMachinesYet}</p>}
      </div>

      {enabled && (
        <div className="settings-actions">
          <button
            type="button"
            className="button"
            disabled={disabled || busy !== null || status?.state === 'needsFolder'}
            onClick={() => void syncNow()}
          >
            <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
            {busy === 'sync' ? s.syncing : s.syncNow}
          </button>
        </div>
      )}
      <Status message={message} />
    </SettingsCard>
  );
}

// ── Project aliases ───────────────────────────────────────────────────────────

function AliasesCard({ data, disabled }: { data: SettingsData | null; disabled: boolean }) {
  const a = t.aliases;
  // The list as last asked for, shown while the tables are being rebuilt.
  const [pending, setPending] = useState<ProjectAlias[] | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = pending ?? data?.aliases.list ?? [];
  const known = data?.aliases.knownProjects ?? [];

  const save = async (next: ProjectAlias[]) => {
    setPending(next);
    try {
      await window.api.setSettings({ projectAliases: next });
    } catch (failure) {
      console.error('Could not change the aliases', failure);
      setError(t.app.actionFailed);
    } finally {
      setPending(null);
    }
  };

  const add = () => {
    const old = from.trim();
    const renamed = to.trim();
    const problem = aliasProblem(list, old, renamed);
    if (problem) {
      setError(a.problems[problem]);
      return;
    }
    setError(null);
    setFrom('');
    setTo('');
    void save([...list, { from: old, to: renamed }]);
  };

  const busy = disabled || pending !== null;
  return (
    <SettingsCard
      title={a.title}
      aside={pending ? <span className="settings-hint">{a.applying}</span> : undefined}
    >
      <p className="settings-hint">{a.hint}</p>
      <p className="settings-hint alias-example num">{a.example}</p>
      {list.length === 0 ? (
        <p className="settings-empty">{a.empty}</p>
      ) : (
        <ul className="alias-list">
          {list.map((alias) => (
            <li key={alias.from} className="alias-item">
              <span className="alias-name" title={alias.from}>
                {alias.from}
              </span>
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" className="alias-arrow" />
              <span className="alias-name" title={alias.to}>
                {alias.to}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={a.remove(alias.from, alias.to)}
                title={a.remove(alias.from, alias.to)}
                disabled={busy}
                onClick={() => void save(list.filter((item) => item.from !== alias.from))}
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="alias-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="text-field"
          list="alias-projects"
          placeholder={a.from}
          aria-label={a.from}
          value={from}
          disabled={busy}
          onChange={(event) => setFrom(event.target.value)}
        />
        <ArrowRight size={14} strokeWidth={2} aria-hidden="true" className="alias-arrow" />
        <input
          className="text-field"
          list="alias-projects"
          placeholder={a.to}
          aria-label={a.to}
          value={to}
          disabled={busy}
          onChange={(event) => setTo(event.target.value)}
        />
        <button type="submit" className="button button--small" disabled={busy}>
          {a.add}
        </button>
        <datalist id="alias-projects">
          {known.map((project) => (
            <option key={project} value={project} />
          ))}
        </datalist>
      </form>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}

// ── Application ───────────────────────────────────────────────────────────────

function AppCard({ data, disabled }: { data: SettingsData | null; disabled: boolean }) {
  const a = t.app;
  const filters = useRangeFilters();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useStatus();
  const settings = data?.app;

  const change = async (patch: Parameters<typeof window.api.setSettings>[0], key: string) => {
    setBusy(key);
    try {
      await window.api.setSettings(patch);
    } catch (error) {
      console.error('Could not change the setting', error);
      setStatus(a.actionFailed);
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async (kind: CsvKind) => {
    setBusy(kind);
    try {
      const result = await window.api.exportCsv(kind, filters);
      if (result.status === 'saved') setStatus(a.exported(result.rows, result.file));
      else if (result.status === 'failed') setStatus(a.exportFailed);
    } catch (error) {
      console.error('Export failed', error);
      setStatus(a.exportFailed);
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    setBusy('rebuild');
    try {
      const result = await window.api.rebuildDatabase();
      if (result.status === 'done') setStatus(a.rebuilt);
      else if (result.status === 'failed') setStatus(a.actionFailed);
    } catch (error) {
      console.error('Rebuild failed', error);
      setStatus(a.actionFailed);
    } finally {
      setBusy(null);
    }
  };

  const loginReason =
    settings?.launchAtLoginUnavailable === 'development'
      ? a.launchUnavailableDev
      : settings?.launchAtLoginUnavailable === 'platform'
        ? a.launchUnavailablePlatform
        : undefined;

  return (
    <SettingsCard title={a.title}>
      <div className="settings-rows">
        <Row label={a.launchAtLogin} hint={loginReason}>
          <Switch
            label={a.launchAtLogin}
            checked={settings?.launchAtLogin ?? false}
            disabled={disabled || !settings || loginReason !== undefined || busy !== null}
            title={loginReason}
            onChange={(on) => void change({ launchAtLogin: on }, 'login')}
          />
        </Row>
        <Row label={a.fileWatching} hint={a.fileWatchingHint}>
          <Switch
            label={a.fileWatching}
            checked={settings?.fileWatching ?? false}
            disabled={disabled || !settings || busy !== null}
            onChange={(on) => void change({ fileWatching: on }, 'watch')}
          />
        </Row>
        <Row label={a.export} hint={a.exportHint} stacked>
          <span className="export-buttons">
            {CSV_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="button button--small"
                disabled={disabled || busy !== null}
                onClick={() => void exportCsv(kind)}
              >
                {a.exports[kind]}
              </button>
            ))}
          </span>
        </Row>
        <Row label={a.rebuildLabel} hint={a.rebuildHint}>
          <button
            type="button"
            className="button button--small"
            disabled={disabled || busy !== null}
            onClick={() => void rebuild()}
          >
            {busy === 'rebuild' ? a.rebuilding : a.rebuild}
          </button>
        </Row>
        <Row label={a.dataFolder}>
          <span className="num settings-path" title={settings?.dataFolder}>
            {settings?.dataFolder ?? NO_VALUE}
          </span>
        </Row>
        <Row label={a.version}>
          <span className="num">{settings?.version ?? NO_VALUE}</span>
        </Row>
      </div>
      <Status message={status} />
      <div className="settings-about">
        <span className="settings-label">
          <Info size={14} strokeWidth={2} aria-hidden="true" />
          {a.about}
        </span>
        <p className="settings-hint">
          {en.app.name}. {a.disclaimer}
        </p>
        <p className="settings-hint">{a.local}</p>
      </div>
    </SettingsCard>
  );
}

// ── Pricing ───────────────────────────────────────────────────────────────────

function PricingCard({ data, disabled }: { data: SettingsData | null; disabled: boolean }) {
  const p = t.pricing;
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useStatus();

  const save = async (pricing: Pricing) => {
    setSaving(true);
    try {
      await window.api.setSettings({ pricing });
      setStatus(p.saved);
    } catch (error) {
      console.error('Could not save the prices', error);
      setStatus(t.app.actionFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title={p.title}
      className="pricing-card"
      aside={<span className="settings-hint">{p.subtitle}</span>}
    >
      <p className="settings-hint">{p.verify}</p>
      {data && (
        <PricingEditor
          key={JSON.stringify(data.pricing.current)}
          current={data.pricing.current}
          defaults={data.pricing.defaults}
          usedModels={data.pricing.usedModels}
          showAll={showAll}
          disabled={disabled}
          saving={saving}
          onSave={(pricing) => void save(pricing)}
          onToggleShowAll={() => setShowAll((value) => !value)}
        />
      )}
      <Status message={status} />
    </SettingsCard>
  );
}
