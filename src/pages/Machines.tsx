import { MonitorSmartphone } from 'lucide-react';
import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import type { MachineCard as MachineCardData, MachinesDetail } from '../../shared/types';
import { staleDays } from '../../shared/sync';
import { EmptyState } from '../components/EmptyState';
import { MachineIcon } from '../components/MachineIcon';
import { MachineWeeklyBars, type MachineSeries } from '../components/MachineWeeklyBars';
import { Page } from '../components/Page';
import { ProjectMachineBars } from '../components/ProjectMachineBars';
import { useNow } from '../hooks/useNow';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { machineColor } from '../lib/chart';
import { formatCost, formatInt, formatPercent, formatTimeAgo, formatTokens } from '../lib/format';
import { useAppData } from '../state/appData';

const t = en.machines;

export function Machines() {
  const range = useRangeFilters();
  // The page compares every machine: the machine filter does not apply.
  const { from, to } = range;
  const fetchMachines = useCallback(() => window.api.getMachinesDetail({ from, to }), [from, to]);
  const { data } = useUsageQuery(fetchMachines, { syncStatus: true });
  const { sync } = useAppData();

  if (data && !data.hasData && data.cards.length <= 1) {
    return (
      <Page section="machines" machinesIgnored={t.machinesIgnored}>
        <EmptyState
          icon={<MonitorSmartphone size={22} strokeWidth={1.75} />}
          title={t.single.title}
          body={t.single.body}
        >
          <Link className="button" to="/settings">
            {t.single.action}
          </Link>
        </EmptyState>
      </Page>
    );
  }

  const cards = data?.cards ?? [];
  const series: MachineSeries[] = cards.map((card, index) => ({
    name: card.name,
    color: machineColor(index),
  }));
  const alone = data !== null && cards.length <= 1;

  return (
    <Page section="machines" machinesIgnored={t.machinesIgnored}>
      <div className="machine-grid">
        {cards.map((card, index) => (
          <MachineCard
            key={card.id}
            card={card}
            color={machineColor(index)}
            syncOn={sync?.enabled ?? false}
          />
        ))}
        {alone && (
          <div className="card machine-card machine-card--hint">
            <h2 className="card-title">{t.single.title}</h2>
            <p className="settings-hint">{t.single.body}</p>
            <Link className="button button--small" to="/settings">
              {t.single.action}
            </Link>
          </div>
        )}
      </div>
      <div className="machines-charts">
        <WeeklyCard data={data} series={series} />
        <ProjectsCard data={data} series={series} />
      </div>
    </Page>
  );
}

function MachineCard({
  card,
  color,
  syncOn,
}: {
  card: MachineCardData;
  color: string;
  syncOn: boolean;
}) {
  const now = useNow();
  const stale = staleDays(card.lastSync, now);
  const status =
    card.isLocal && !syncOn
      ? t.localOnly
      : stale !== null
        ? t.stale(stale)
        : card.lastSync
          ? t.syncedAgo(formatTimeAgo(card.lastSync, now))
          : t.notSynced;

  return (
    <section className="card machine-card" aria-label={card.name}>
      <header className="machine-card-header">
        <span className="machine-card-name">
          <span className="machine-card-icon" style={{ color }}>
            <MachineIcon platform={card.platform} />
          </span>
          <h2 className="card-title">{card.name}</h2>
        </span>
        <span className="settings-hint">
          {en.platforms[card.platform]}
          {card.isLocal && ` · ${t.thisMachine}`}
        </span>
      </header>
      <div className="machine-card-total">
        <span className="machine-card-tokens num">{formatTokens(card.tokens)}</span>
        <span className="machine-card-share num">{formatPercent(card.share)}</span>
      </div>
      <dl className="machine-card-stats">
        <div>
          <dt>{t.activeDays}</dt>
          <dd className="num">{formatInt(card.activeDays)}</dd>
        </div>
        <div>
          <dt>{t.sessions}</dt>
          <dd className="num">{formatInt(card.sessions)}</dd>
        </div>
        <div>
          <dt>{t.projectCount}</dt>
          <dd className="num">{formatInt(card.projects)}</dd>
        </div>
        <div>
          <dt>{t.cost}</dt>
          <dd className="num">{formatCost(card.cost)}</dd>
        </div>
      </dl>
      <p
        className={`machine-card-sync${stale !== null ? ' is-stale' : ''}`}
        title={stale !== null ? t.staleHint : (card.lastSync ?? undefined)}
      >
        <span className="status-dot" aria-hidden="true" />
        {status}
      </p>
    </section>
  );
}

function WeeklyCard({ data, series }: { data: MachinesDetail | null; series: MachineSeries[] }) {
  const w = t.weekly;
  const title =
    series.length >= 2 && series.length <= 3 ? w.versus(series.map((s) => s.name)) : w.title;
  return (
    <section className="card chart-card machines-weekly">
      <header className="chart-card-header">
        <h2 className="card-title">{title}</h2>
        <div className="chart-legend">
          {series.map((machine, index) => (
            <span key={`${index}-${machine.name}`} className="chart-legend-item">
              <span className="swatch" style={{ background: machine.color }} aria-hidden="true" />
              {machine.name}
            </span>
          ))}
        </div>
      </header>
      <div className="chart-card-body">
        <MachineWeeklyBars data={data?.weekly ?? []} series={series} label={w.chartLabel} />
      </div>
    </section>
  );
}

function ProjectsCard({ data, series }: { data: MachinesDetail | null; series: MachineSeries[] }) {
  const p = t.projects;
  const projects = data?.projects ?? [];
  return (
    <section className="card chart-card machines-projects">
      <header className="chart-card-header">
        <h2 className="card-title">{p.title}</h2>
      </header>
      {data && projects.length === 0 ? (
        <p className="panel-empty">{p.empty}</p>
      ) : (
        <ProjectMachineBars projects={projects} series={series} label={p.chartLabel} />
      )}
      {data && data.moreProjects > 0 && (
        <p className="settings-hint">{p.more(data.moreProjects)}</p>
      )}
    </section>
  );
}
