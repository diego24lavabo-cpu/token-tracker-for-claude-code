import { FolderSearch } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Live as LiveData, LiveHours, LiveMachine, LiveWindow } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { KpiCard } from '../components/KpiCard';
import { LiveBars } from '../components/LiveBars';
import { MachineIcon } from '../components/MachineIcon';
import { Page } from '../components/Page';
import { SegmentedControl, type SegmentedOption } from '../components/SegmentedControl';
import { useNow } from '../hooks/useNow';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { strings } from '../i18n';
import {
  formatClock,
  formatCost,
  formatCountdown,
  formatDay,
  formatDuration,
  formatPercent,
  formatTimeAgo,
  formatTokens,
} from '../lib/format';
import { seriesColor } from '../lib/chart';
import { liveSeriesLabel } from '../lib/live';
import { useAppData } from '../state/appData';
import { ALL_MACHINES, useFilters } from '../state/filters';

const NO_VALUE = '—';
const t = strings.live;
const HOURS: readonly LiveHours[] = [1, 3, 6];
/** The page asks again every minute, so the chart's minutes keep moving without new logs. */
const REFRESH_MS = 60_000;

export function Live() {
  const { machineId } = useFilters();
  const { info } = useAppData();
  const [hours, setHours] = useState<LiveHours>(3);
  // Bumped to ask again: every minute, and just after the running window resets.
  const [refresh, setRefresh] = useState(0);
  const fetchLive = useCallback(
    () => window.api.getLive(machineId === ALL_MACHINES ? undefined : [machineId], hours),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refresh` is the reload trigger
    [machineId, hours, refresh],
  );
  const { data } = useUsageQuery(fetchLive);

  useEffect(() => {
    const timer = setInterval(() => setRefresh((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // The main machine shown at the top: this computer, or the one picked in the header.
  const machine = data?.machines[0] ?? null;
  const windowEnd = machine?.window?.end ?? null;
  useEffect(() => {
    if (windowEnd === null) return;
    const delay = windowEnd - Date.now() + 1_000;
    // `setTimeout` cannot wait longer than 2^31 ms; a window is 5 hours.
    if (delay <= 0) return;
    const timer = setTimeout(() => setRefresh((count) => count + 1), delay);
    return () => clearTimeout(timer);
  }, [windowEnd]);

  if (data && !data.hasData) {
    return (
      <Page section="live" periodIgnored={t.periodIgnored}>
        <EmptyState
          icon={<FolderSearch size={22} strokeWidth={1.75} />}
          title={strings.overview.empty.title}
          body={strings.overview.empty.body(
            info?.logRoots[0] ?? info?.defaultLogRoot ?? '~/.claude/projects',
          )}
        />
      </Page>
    );
  }

  const running = machine?.status === 'active' ? machine : null;

  return (
    <Page section="live" periodIgnored={t.periodIgnored}>
      {info && !info.fileWatching && (
        <div className="live-notice">
          <span>{t.watchingOff}</span>
          {!info.demo && (
            <Link to="/settings" className="button button--small">
              {t.watchingSettings}
            </Link>
          )}
        </div>
      )}
      {data && machine && !running ? <IdleCard machine={machine} /> : <KpiRow machine={running} />}
      <div className="live-layout">
        <ChartCard data={data} hours={hours} onHours={setHours} current={running?.window ?? null} />
        <div className="live-side">
          <ActiveCard data={data} />
          {data && data.machines.length > 1 && <MachinesCard machines={data.machines} />}
        </div>
      </div>
      <p className="live-note">{t.note}</p>
    </Page>
  );
}

// ── Window ────────────────────────────────────────────────────────────────────

function KpiRow({ machine }: { machine: LiveMachine | null }) {
  const now = useNow();
  const current = machine?.window ?? null;
  const k = t.kpi;

  return (
    <div className="kpi-grid kpi-grid--5">
      {current ? (
        <KpiCard
          label={k.window}
          value={formatTokens(current.total)}
          hint={k.windowHint(current.startAt.time, formatCost(costOf(current)))}
          title={k.windowTitle}
        />
      ) : (
        <KpiCard label={k.window} value={NO_VALUE} hint={NO_VALUE} title={k.windowTitle} />
      )}
      {current ? (
        <ResetsCard window={current} />
      ) : (
        <KpiCard label={k.resets} value={NO_VALUE} hint={NO_VALUE} title={k.resetsTitle} />
      )}
      <SpeedCard machine={machine} />
      <UsageCard machine={machine} />
      <LimitCard machine={machine} now={now} />
    </div>
  );
}

/** The window's cost at API prices, or null when none of its models has a price. */
function costOf(win: LiveWindow): number | null {
  return win.total > 0 && win.unpricedTokens >= win.total ? null : win.units;
}

/** The reset time and a countdown to the second. Kept apart: it renders every second. */
function ResetsCard({ window: win }: { window: LiveWindow }) {
  const now = useNow(1_000);
  const today = useToday();
  const countdown = formatCountdown(win.end - now);
  const k = t.kpi;
  return (
    <KpiCard
      label={k.resets}
      value={win.endAt.time}
      hint={win.endAt.day > today ? k.resetsTomorrow(countdown) : k.resetsIn(countdown)}
      title={k.resetsTitle}
    />
  );
}

function SpeedCard({ machine }: { machine: LiveMachine | null }) {
  const k = t.kpi;
  const burn = machine?.burn;
  const moving = burn !== undefined && burn.tokensPerMinute > 0;
  return (
    <KpiCard
      label={k.speed}
      value={burn ? k.speedValue(formatTokens(burn.tokensPerMinute)) : NO_VALUE}
      hint={
        burn
          ? moving
            ? k.speedHint(formatCost(burn.unitsPerMinute * 60), burn.minutes)
            : k.speedIdle(burn.minutes)
          : NO_VALUE
      }
      title={k.speedTitle}
    />
  );
}

function UsageCard({ machine }: { machine: LiveMachine | null }) {
  const k = t.kpi;
  const estimate = machine?.estimate ?? null;
  return (
    <KpiCard
      label={k.usage}
      value={estimate ? formatPercent(estimate.percent / 100) : NO_VALUE}
      hint={
        estimate
          ? k.usageHint(formatDay(estimate.reference.startAt.day))
          : machine
            ? k.usageNone
            : NO_VALUE
      }
      title={k.usageTitle}
    />
  );
}

function LimitCard({ machine, now }: { machine: LiveMachine | null; now: number }) {
  const k = t.kpi;
  const estimate = machine?.estimate ?? null;
  const title = k.limitTitle;
  if (!machine) return <KpiCard label={k.limit} value={NO_VALUE} hint={NO_VALUE} title={title} />;
  if (!estimate) {
    return <KpiCard label={k.limit} value={NO_VALUE} hint={k.usageNone} title={title} />;
  }
  switch (estimate.outcome) {
    case 'limitFirst':
      return (
        <KpiCard
          label={k.limit}
          value={estimate.limitAt === null ? NO_VALUE : formatClock(estimate.limitAt)}
          hint={
            estimate.limitAt === null ? NO_VALUE : k.limitIn(formatDuration(estimate.limitAt - now))
          }
          title={title}
        />
      );
    case 'resetsFirst':
      return (
        <KpiCard
          label={k.limit}
          value={k.limitAfterReset}
          hint={k.limitAfterResetHint}
          title={title}
          compact
        />
      );
    case 'reached':
      return (
        <KpiCard
          label={k.limit}
          value={k.limitReached}
          hint={k.limitReachedHint}
          title={title}
          compact
        />
      );
    case 'noRate':
      return (
        <KpiCard
          label={k.limit}
          value={NO_VALUE}
          hint={k.speedIdle(machine.burn.minutes)}
          title={title}
        />
      );
  }
}

/** Shown instead of the KPI row when no window is running. */
function IdleCard({ machine }: { machine: LiveMachine }) {
  const previous = machine.previous;
  const noLive = machine.status === 'noLiveData';
  return (
    <section className="card live-idle">
      <h2 className="card-title">{noLive ? t.idle.noLive(machine.name) : t.idle.title}</h2>
      <p className="live-idle-body">{noLive ? t.idle.noLiveBody : t.idle.body}</p>
      {!noLive && previous && (
        <p className="live-idle-last num">
          {t.idle.last(
            `${formatDay(previous.startAt.day)}, ${previous.startAt.time}`,
            previous.endAt.time,
            formatTokens(previous.total),
            formatCost(costOf(previous)),
          )}
        </p>
      )}
    </section>
  );
}

// ── Chart ─────────────────────────────────────────────────────────────────────

function ChartCard({
  data,
  hours,
  onHours,
  current,
}: {
  data: LiveData | null;
  hours: LiveHours;
  onHours: (hours: LiveHours) => void;
  current: LiveWindow | null;
}) {
  const options: SegmentedOption<`${LiveHours}`>[] = HOURS.map((value) => ({
    value: `${value}`,
    label: t.chart.ranges[`${value}`],
  }));
  const empty = data !== null && data.series.length === 0;

  return (
    <section className="card chart-card live-chart-card">
      <header className="chart-card-header">
        <div className="live-chart-title">
          <h2 className="card-title">{t.chart.title}</h2>
          <span className="chart-card-hint">{t.chart.hint}</span>
        </div>
        <SegmentedControl
          label={t.chart.range}
          options={options}
          value={`${hours}`}
          onChange={(value) => onHours(Number(value) as LiveHours)}
          tone="neutral"
          size="small"
        />
      </header>
      {data && data.series.length > 0 && (
        <ul className="chart-legend live-legend" aria-label={t.chart.title}>
          {data.series.map((series, index) => (
            <li key={series.project ?? 'others'} className="chart-legend-item">
              <span
                className="swatch"
                style={{ background: seriesColor(index) }}
                aria-hidden="true"
              />
              <span className="live-legend-name" title={liveSeriesLabel(series)}>
                {liveSeriesLabel(series)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="chart-card-body live-chart">
        {data ? (
          <LiveBars
            hours={data.hours}
            series={data.series}
            minutes={data.minutes}
            windowStart={current?.start ?? null}
            label={t.chart.label(data.hours)}
          />
        ) : null}
        {empty && <p className="chart-empty">{t.chart.empty}</p>}
      </div>
    </section>
  );
}

// ── Side cards ────────────────────────────────────────────────────────────────

function ActiveCard({ data }: { data: LiveData | null }) {
  const now = useNow();
  const active = data?.active ?? [];

  return (
    <section className="card live-side-card">
      <header className="chart-card-header">
        <h2 className="card-title">{t.active.title}</h2>
        <span className="chart-card-hint">{t.active.hint}</span>
      </header>
      {data && active.length === 0 ? (
        <p className="live-side-empty">{t.active.empty}</p>
      ) : (
        <ul className="live-active" aria-label={t.active.label}>
          {active.map((project) => (
            <li key={project.project} className="live-active-row">
              <span className="live-active-main">
                <span className="live-active-name" title={project.project}>
                  {project.project}
                </span>
                <span className="live-active-models">{project.models.join(' · ')}</span>
              </span>
              <span className="live-active-figures">
                <span className="num">{formatTokens(project.tokens)}</span>
                <span className="live-active-ago">
                  {formatTimeAgo(new Date(project.last).toISOString(), now)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One line per machine, for the machines selected in the header. */
function MachinesCard({ machines }: { machines: LiveMachine[] }) {
  const m = t.machines;
  const status = (machine: LiveMachine) => {
    if (machine.status === 'active' && machine.window) return m.active(machine.window.endAt.time);
    if (machine.status === 'noLiveData') return m.noLive;
    if (machine.status === 'noData') return m.noData;
    return m.idle;
  };

  return (
    <section className="card live-side-card">
      <header className="chart-card-header">
        <h2 className="card-title">{m.title}</h2>
      </header>
      <ul className="live-machines">
        {machines.map((machine) => (
          <li key={machine.machineId} className="live-machine-row">
            <MachineIcon platform={machine.platform} />
            <span className="live-machine-text">
              <span className="live-machine-name" title={machine.name}>
                {machine.name}
              </span>
              <span className="live-machine-status">{status(machine)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
