import { FolderPlus, Info, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CsvKind, Pricing, SettingsData } from '../../shared/types';
import { Page } from '../components/Page';
import { PricingEditor } from '../components/PricingEditor';
import { Switch } from '../components/Switch';
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
import { useAppData } from '../state/appData';

const t = en.settings;
const NO_VALUE = '—';
const CSV_KINDS: readonly CsvKind[] = ['daily', 'projects', 'models', 'agentTypes'];
/** How long a confirmation message stays under its button. */
const STATUS_MS = 8_000;

export function Settings() {
  const fetchSettings = useCallback(() => window.api.getSettings(), []);
  const { data } = useUsageQuery(fetchSettings);
  const disabled = !data?.available;

  return (
    <Page section="settings">
      {data && !data.available && <p className="settings-notice">{t.unavailable}</p>}
      <div className="settings-columns">
        <SourcesCard data={data} disabled={disabled} />
        <AppCard data={data} disabled={disabled} />
        <ContainersCard data={data} disabled={disabled} />
        <SyncCard />
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

/** Re-renders every half minute, for "4 min ago". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
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

  const keepLonger = () =>
    run('retention', async () => {
      const result = await window.api.keepHistoryLonger();
      if (result.status === 'done') return s.keepLongerDone;
      return result.status === 'failed' ? t.app.actionFailed : null;
    });

  const days = retention ? (retention.cleanupPeriodDays ?? retention.defaultDays) : null;
  const canRaise =
    retention !== undefined &&
    retention.readable &&
    days !== null &&
    days < retention.suggestedDays;

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
              <button
                type="button"
                className="button"
                disabled={disabled || busy !== null}
                onClick={() => void keepLonger()}
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

// ── Sync (step 10) ────────────────────────────────────────────────────────────

function SyncCard() {
  const s = t.sync;
  const { machines } = useAppData();
  const local = machines.find((machine) => machine.isLocal);
  return (
    <SettingsCard title={s.title}>
      <div className="settings-rows">
        <Row label={s.status}>{s.off}</Row>
        <Row label={s.thisMachine}>
          <span className="num">{local?.name ?? NO_VALUE}</span>
        </Row>
        <Row label={s.knownMachines}>
          <span className="num">{machines.length > 0 ? formatInt(machines.length) : NO_VALUE}</span>
        </Row>
      </div>
      <p className="settings-hint">{s.hint}</p>
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
