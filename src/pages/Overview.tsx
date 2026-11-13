import { FolderSearch } from 'lucide-react';
import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { Overview as OverviewData } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { KpiCard } from '../components/KpiCard';
import { Page } from '../components/Page';
import { ShortcutCard } from '../components/ShortcutCard';
import { StackedDailyBars } from '../components/StackedDailyBars';
import { useNow } from '../hooks/useNow';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { formatCost, formatInt, formatPercent, formatTimeAgo, formatTokens } from '../lib/format';
import { useAppData } from '../state/appData';

const NO_VALUE = '—';
const t = en.overview;

export function Overview() {
  const filters = useRangeFilters();
  const today = useToday();
  const { info } = useAppData();
  const fetchOverview = useCallback(() => window.api.getOverview(filters), [filters]);
  const { data } = useUsageQuery(fetchOverview);

  if (data && !data.hasData) {
    const noFolder = info !== null && info.logRoots.length === 0;
    const folder = info?.logRoots[0] ?? info?.defaultLogRoot ?? '~/.claude/projects';
    return (
      <Page section="overview">
        <EmptyState
          icon={<FolderSearch size={22} strokeWidth={1.75} />}
          title={t.empty.title}
          body={noFolder ? t.empty.noFolder(folder) : t.empty.body(folder)}
        >
          {info && !info.demo && (
            <div className="empty-state-actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void window.api.addLogFolder()}
              >
                {t.empty.pickFolder}
              </button>
              <Link to="/settings" className="button">
                {t.empty.settings}
              </Link>
            </div>
          )}
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page section="overview">
      <KpiRow data={data} />
      <DailyCard data={data} today={today} />
      <Shortcuts data={data} />
    </Page>
  );
}

function KpiRow({ data }: { data: OverviewData | null }) {
  const kpis = data?.kpis;
  const share = (part: number) =>
    kpis && kpis.totalTokens > 0
      ? formatPercent(part / kpis.totalTokens, { precise: true })
      : NO_VALUE;

  let changeHint: string = NO_VALUE;
  if (kpis?.totalChange.kind === 'change') {
    changeHint = `${formatPercent(kpis.totalChange.ratio, { signed: true })} ${t.kpi.vsPrevious}`;
  } else if (kpis?.totalChange.kind === 'new') {
    changeHint = t.kpi.newActivity;
  } else if (kpis) {
    changeHint = t.kpi.noPrevious;
  }

  let costHint: string = t.kpi.costHint;
  if (kpis && kpis.cost === null && kpis.totalTokens > 0) costHint = t.kpi.costUnknown;
  else if (kpis?.costIsPartial) costHint = t.kpi.costPartial;

  return (
    <div className="kpi-grid">
      <KpiCard
        label={t.kpi.total}
        value={kpis ? formatTokens(kpis.totalTokens) : NO_VALUE}
        hint={changeHint}
      />
      <KpiCard
        label={t.kpi.input}
        value={kpis ? formatTokens(kpis.inputTokens) : NO_VALUE}
        hint={`${share(kpis?.inputTokens ?? 0)} · ${t.kpi.inputHint}`}
      />
      <KpiCard
        label={t.kpi.output}
        value={kpis ? formatTokens(kpis.outputTokens) : NO_VALUE}
        hint={`${share(kpis?.outputTokens ?? 0)} · ${t.kpi.outputHint}`}
      />
      <KpiCard
        label={t.kpi.cost}
        value={kpis ? formatCost(kpis.cost) : NO_VALUE}
        hint={costHint}
        title={t.kpi.costTitle}
      />
    </div>
  );
}

function DailyCard({ data, today }: { data: OverviewData | null; today: string }) {
  const daily = data?.daily ?? [];
  const peak = daily.reduce((max, point) => Math.max(max, point.input + point.output), 0);

  return (
    <section className="card chart-card chart-card--grow">
      <header className="chart-card-header">
        <h2 className="card-title">{t.daily.title}</h2>
        <div className="chart-legend">
          <span className="chart-legend-item">
            <span className="swatch swatch--input" aria-hidden="true" />
            {t.daily.input}
          </span>
          <span className="chart-legend-item">
            <span className="swatch swatch--output" aria-hidden="true" />
            {t.daily.output}
          </span>
          <span className="chart-legend-item">
            · {t.daily.peak} <span className="num chart-legend-value">{formatTokens(peak)}</span>
          </span>
        </div>
      </header>
      <div className="chart-card-body">
        <StackedDailyBars data={daily} today={today} />
        {data && peak === 0 && <p className="chart-empty">{t.daily.empty}</p>}
      </div>
    </section>
  );
}

function Shortcuts({ data }: { data: OverviewData | null }) {
  const shortcuts = data?.shortcuts;
  const s = t.shortcuts;
  const { sync } = useAppData();
  const now = useNow();
  const syncDetail = !sync?.enabled
    ? s.localOnly
    : sync.state === 'synced' && sync.lastSync
      ? s.syncedAgo(formatTimeAgo(sync.lastSync, now))
      : s.syncPending;

  const project = shortcuts?.project;
  const model = shortcuts?.model;
  const activity = shortcuts?.activity;
  const sessions = shortcuts?.sessions;
  const subagents = shortcuts?.subagents;
  const machines = shortcuts?.machines ?? [];

  return (
    <div className="shortcut-grid">
      <ShortcutCard
        label={s.project}
        to="/projects"
        headline={project ? project.name : shortcuts ? s.none : NO_VALUE}
        detail={
          project ? `${formatPercent(project.share)} · ${formatTokens(project.tokens)}` : NO_VALUE
        }
      />
      <ShortcutCard
        label={s.model}
        to="/models"
        headline={model ? model.name : shortcuts ? s.none : NO_VALUE}
        detail={
          model
            ? `${formatPercent(model.share)} · ${s.cache} ${formatPercent(model.cacheHitRate)}`
            : NO_VALUE
        }
      />
      <ShortcutCard
        label={s.activity}
        to="/calendar"
        headline={
          activity
            ? activity.currentStreak > 0
              ? s.streak(activity.currentStreak)
              : s.noStreak
            : NO_VALUE
        }
        detail={activity ? s.activeDays(activity.activeDays, activity.periodDays) : NO_VALUE}
      />
      <ShortcutCard
        label={s.sessions}
        to="/sessions"
        headline={sessions ? s.sessionCount(sessions.count, formatInt(sessions.count)) : NO_VALUE}
        detail={
          sessions && sessions.count > 0
            ? s.averageTokens(formatTokens(sessions.averageTokens))
            : NO_VALUE
        }
      />
      <ShortcutCard
        label={s.subagents}
        to="/agents"
        headline={subagents ? s.subagentShare(formatPercent(subagents.share)) : NO_VALUE}
        detail={
          subagents
            ? s.invocations(subagents.invocations, formatInt(subagents.invocations))
            : NO_VALUE
        }
      />
      <ShortcutCard
        label={s.machines}
        to="/machines"
        headline={
          machines.length > 0
            ? machines
                .map((machine) => `${machine.name} ${formatPercent(machine.share)}`)
                .join(' · ')
            : shortcuts
              ? s.none
              : NO_VALUE
        }
        detail={shortcuts ? syncDetail : NO_VALUE}
      />
    </div>
  );
}
