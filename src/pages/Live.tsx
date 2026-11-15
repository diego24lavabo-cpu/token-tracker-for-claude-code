import { FolderSearch } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LIVE_MIN_VERSION } from '../../shared/sync';
import type {
  Live as LiveData,
  LiveBurn,
  LiveEstimate,
  LiveHours,
  LiveMachine,
  LiveReference,
  LiveReferenceChoice,
  LiveReferenceInfo,
  LiveStatus,
  LiveWindow,
  LocalDayTime,
} from '../../shared/types';
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
/** How long a message stays under the calibration form. */
const STATUS_MS = 8_000;

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
  const { data } = useUsageQuery(fetchLive, { live: true });

  useEffect(() => {
    const timer = setInterval(() => setRefresh((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // The top of the page: every computer together under "All" while their live data is
  // fresh, else this computer or the one picked in the header.
  const line = data ? topLine(data, machineId === ALL_MACHINES) : null;
  const estimate = data?.estimate ?? null;
  // Claude's own reset time when its % is in use, else the rebuilt window's.
  const windowEnd = estimate?.resetsAt ?? line?.window?.end ?? null;
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

  const running = line?.status === 'active' ? line : null;

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
      {line && !running ? (
        <IdleCard line={line} />
      ) : (
        <KpiRow
          line={running}
          estimate={estimate}
          counted={data?.reference.scope.counted.length ?? 0}
          accountRunning={data?.reference.canCalibrate ?? false}
        />
      )}
      <div className="live-layout">
        <ChartCard data={data} hours={hours} onHours={setHours} current={running?.window ?? null} />
        <div className="live-side">
          <ActiveCard data={data} />
          {data && <ReferenceCard info={data.reference} demo={info?.demo ?? false} />}
          {data && data.machines.length > 1 && <MachinesCard machines={data.machines} />}
        </div>
      </div>
      <p className="live-note">{t.note}</p>
    </Page>
  );
}

// ── Window ────────────────────────────────────────────────────────────────────

/** A window and speed at the top of the page: one machine's, or every computer's together. */
interface TopLine {
  status: LiveStatus;
  window: LiveWindow | null;
  previous: LiveWindow | null;
  burn: LiveBurn;
  /** The machine's name; null for every computer together. */
  name: string | null;
  /** Another computer: when its live data was written. */
  liveAtTime: LocalDayTime | null;
  /** How many computers it counts. */
  computers: number;
}

function topLine(data: LiveData, all: boolean): TopLine | null {
  if (all && data.combined) {
    return {
      ...data.combined,
      name: null,
      liveAtTime: null,
      computers: data.combined.machines.length,
    };
  }
  const machine = data.machines[0];
  return machine ? { ...machine, computers: 1 } : null;
}

/**
 * `counted`: how many other computers the estimate counts. `accountRunning`: the
 * account's window is running (with usage), whichever machine is shown.
 */
function KpiRow({
  line,
  estimate,
  counted,
  accountRunning,
}: {
  line: TopLine | null;
  estimate: LiveEstimate | null;
  counted: number;
  accountRunning: boolean;
}) {
  // Without an estimate: no reference to compare with, or no account window running.
  const missing = accountRunning ? t.kpi.usageNone : t.kpi.usageNoWindow;
  const now = useNow();
  const current = line?.window ?? null;
  const k = t.kpi;
  const all = line !== null && line.computers > 1;

  return (
    <div className="kpi-grid kpi-grid--5">
      {current ? (
        <KpiCard
          label={k.window}
          value={formatTokens(current.total)}
          hint={
            all
              ? k.windowHintAll(current.startAt.time, line.computers, formatCost(costOf(current)))
              : k.windowHint(current.startAt.time, formatCost(costOf(current)))
          }
          title={all ? k.windowTitleAll : k.windowTitle}
        />
      ) : (
        <KpiCard label={k.window} value={NO_VALUE} hint={NO_VALUE} title={k.windowTitle} />
      )}
      {current ? (
        <ResetsCard window={current} estimate={estimate} />
      ) : (
        <KpiCard label={k.resets} value={NO_VALUE} hint={NO_VALUE} title={k.resetsTitle} />
      )}
      <SpeedCard burn={line?.burn ?? null} />
      <UsageCard estimate={estimate} missing={line ? missing : null} />
      <LimitCard
        estimate={estimate}
        burn={line?.burn ?? null}
        missing={missing}
        // One computer shown, the speed of all of them counted.
        otherSpeed={line !== null && line.name !== null && counted > 0}
        now={now}
      />
    </div>
  );
}

/** The window's cost at API prices, or null when none of its models has a price. */
function costOf(win: LiveWindow): number | null {
  return win.total > 0 && win.unpricedTokens >= win.total ? null : win.units;
}

/**
 * The reset time and a countdown to the second: Claude's own while its % is in use, else
 * the rebuilt window's. Kept apart: it renders every second.
 */
function ResetsCard({
  window: win,
  estimate,
}: {
  window: LiveWindow;
  estimate: LiveEstimate | null;
}) {
  const now = useNow(1_000);
  const today = useToday();
  const claude = estimate?.reference.kind === 'claude';
  const end = claude ? estimate.resetsAt : win.end;
  const endAt = claude ? estimate.resetsAtTime : win.endAt;
  const countdown = formatCountdown(end - now);
  const k = t.kpi;
  return (
    <KpiCard
      label={k.resets}
      value={endAt.time}
      hint={endAt.day > today ? k.resetsTomorrow(countdown) : k.resetsIn(countdown)}
      title={claude ? k.resetsClaudeTitle : k.resetsTitle}
    />
  );
}

function SpeedCard({ burn }: { burn: LiveBurn | null }) {
  const k = t.kpi;
  const moving = burn !== null && burn.tokensPerMinute > 0;
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

/** How the estimate's reference is named under the usage %. */
function referenceHint(reference: LiveReference): string {
  const k = t.kpi;
  const percent = formatPercent((reference.percent ?? 0) / 100);
  switch (reference.kind) {
    case 'claude':
      return k.usageHintClaude(percent, reference.atTime.time);
    case 'calibration':
      return k.usageHintCalibration(percent, formatDay(reference.atTime.day));
    case 'largestWindow':
      return k.usageHint(formatDay(reference.atTime.day));
  }
}

/** The account's estimate, whichever machine is shown. `shown`: a window is on screen. */
/** `missing`: why there is no estimate; null when no window is shown. */
function UsageCard({
  estimate,
  missing,
}: {
  estimate: LiveEstimate | null;
  missing: string | null;
}) {
  const k = t.kpi;
  return (
    <KpiCard
      label={k.usage}
      value={estimate ? formatPercent(estimate.percent / 100) : NO_VALUE}
      hint={estimate ? referenceHint(estimate.reference) : (missing ?? NO_VALUE)}
      title={k.usageTitle}
    />
  );
}

/** The account's estimate; `burn` is the shown window's speed (null: no window shown). */
function LimitCard({
  estimate,
  burn,
  missing,
  otherSpeed,
  now,
}: {
  estimate: LiveEstimate | null;
  burn: LiveBurn | null;
  missing: string;
  otherSpeed: boolean;
  now: number;
}) {
  const k = t.kpi;
  const title = k.limitTitle;
  if (!burn) return <KpiCard label={k.limit} value={NO_VALUE} hint={NO_VALUE} title={title} />;
  if (!estimate) {
    return <KpiCard label={k.limit} value={NO_VALUE} hint={missing} title={title} />;
  }
  switch (estimate.outcome) {
    case 'limitFirst':
      return (
        <KpiCard
          label={k.limit}
          value={estimate.limitAt === null ? NO_VALUE : k.limitAt(formatClock(estimate.limitAt))}
          hint={
            estimate.limitAt === null
              ? NO_VALUE
              : (otherSpeed ? k.limitInAll : k.limitIn)(formatDuration(estimate.limitAt - now))
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
        <KpiCard label={k.limit} value={NO_VALUE} hint={k.speedIdle(burn.minutes)} title={title} />
      );
    case 'noLimit':
      return <KpiCard label={k.limit} value={NO_VALUE} hint={k.limitUnknown} title={title} />;
  }
}

/** A day and time as the page writes them: the time alone today, else with the day. */
function when(at: LocalDayTime, today: string): string {
  return at.day === today ? at.time : dayTime(at);
}

/** Shown instead of the KPI row when no window is running, or nothing is known of one. */
function IdleCard({ line }: { line: TopLine }) {
  const today = useToday();
  const name = line.name ?? '';
  const previous = line.previous;
  const i = t.idle;
  let title: string = i.title;
  // Every computer together: no window on any of them.
  let body: string = line.name === null ? i.bodyAll : i.body;
  if (line.status === 'noLiveData' || line.status === 'needsUpdate' || line.status === 'newerApp') {
    title = i.noLive(name);
    body =
      line.status === 'needsUpdate'
        ? i.needsUpdateBody(LIVE_MIN_VERSION)
        : line.status === 'newerApp'
          ? i.newerAppBody
          : i.noLiveBody;
  } else if (line.status === 'stale') {
    title = line.liveAtTime ? i.stale(name, when(line.liveAtTime, today)) : i.noLive(name);
    body = i.staleBody;
  }
  const known = line.status === 'idle' || line.status === 'noData';
  return (
    <section className="card live-idle">
      <h2 className="card-title">{title}</h2>
      <p className="live-idle-body">{body}</p>
      {known && previous && (
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

/** A % typed by the user: `38`, `38.5`, `38,5` or `38 %`. NaN when it is not a number. */
function parsePercent(text: string): number {
  const clean = text.replace('%', '').replace(',', '.').trim();
  return clean === '' ? Number.NaN : Number(clean);
}

/** "Nov 14, 14:05": the day and time of a moment, as the idle card writes them. */
function dayTime(at: LiveWindow['startAt']): string {
  return `${formatDay(at.day)}, ${at.time}`;
}

/** The largest window, and with other computers whose window it is. */
function largestLine(info: LiveReferenceInfo): string {
  const r = t.reference;
  const largest = info.largest;
  if (!largest) return r.noLargest;
  const line = r.largestLine(formatDay(largest.startAt.day), formatCost(largest.units));
  if (info.scope.others === 0) return line;
  const whose = largest.computers > 1 ? r.computers(largest.computers) : r.largestThis;
  return `${line} · ${whose}`;
}

/**
 * What the estimates take as 100%: Claude's own % while current, else the choice between
 * the largest window and a calibration, which is entered here.
 */
function ReferenceCard({ info, demo }: { info: LiveReferenceInfo; demo: boolean }) {
  const r = t.reference;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatusText] = useState<string | null>(null);
  // Bumped with every message, so the same message twice restarts its timer.
  const [statusId, setStatusId] = useState(0);
  const setStatus = (text: string) => {
    setStatusText(text);
    setStatusId((id) => id + 1);
  };
  const claude = info.claude;
  const calibration = info.calibration;

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatusText(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status, statusId]);

  const claudeLine = !info.claudeEnabled
    ? r.claudeOff
    : !claude
      ? r.claudeNone
      : claude.fresh
        ? (info.canCalibrate ? r.claudeInUse : r.claudeWaiting)(
            formatPercent(claude.percent / 100),
            claude.fetchedAtTime.time,
            formatClock(claude.resetsAt),
          )
        : r.claudeStale(formatPercent(claude.percent / 100), dayTime(claude.fetchedAtTime));

  const calibrationText = !calibration
    ? r.noCalibration
    : calibration.units === null
      ? r.calibrationLost(formatPercent(calibration.percent / 100), dayTime(calibration.atTime))
      : r.calibrationLine(
          formatPercent(calibration.percent / 100),
          dayTime(calibration.atTime),
          formatCost(calibration.units),
        );
  // With other computers: whose usage the calibration counted.
  const calibrationLine =
    calibration && info.scope.others > 0
      ? `${calibrationText} · ${calibration.computers > 1 ? r.computers(calibration.computers) : r.calibrationLocal}`
      : calibrationText;
  const scopeLine =
    info.scope.others === 0
      ? null
      : info.scope.counted.length > 0
        ? r.scopeAll(info.scope.counted.join(', '))
        : r.scopeLocal;

  const options: SegmentedOption<LiveReferenceChoice>[] = [
    { value: 'largestWindow', label: r.largest },
    {
      value: 'calibration',
      label: r.calibration,
      disabledReason: calibration?.units ? undefined : r.needsCalibration,
    },
  ];
  // A calibration that gives no limit falls back to the largest window, as the estimate does.
  const choice =
    info.choice === 'calibration' && calibration?.units ? 'calibration' : 'largestWindow';

  const pick = async (value: LiveReferenceChoice) => {
    try {
      await window.api.setLiveReference(value);
    } catch (error) {
      console.error('Could not change the reference', error);
      setStatus(r.failed);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const percent = parsePercent(text);
    if (!(percent > 0 && percent <= 100)) {
      setStatus(r.invalid);
      return;
    }
    setBusy(true);
    try {
      const result = await window.api.calibrateLive(percent);
      if (result.status === 'done') {
        setText('');
        setStatus(r.calibrated);
      } else {
        setStatus(r.calibrateNoWindow);
      }
    } catch (error) {
      console.error('Could not calibrate', error);
      setStatus(r.failed);
    } finally {
      setBusy(false);
    }
  };

  const blocked = demo ? r.calibrateDemo : info.canCalibrate ? undefined : r.calibrateNoWindow;

  return (
    <section className="card live-side-card live-reference">
      <header className="chart-card-header">
        <h2 className="card-title">{r.title}</h2>
        <span className="chart-card-hint">{r.hint}</span>
      </header>
      <p
        className={`live-reference-claude${claude?.fresh && info.claudeEnabled && info.canCalibrate ? ' is-on' : ''}`}
      >
        {claudeLine}
      </p>
      {scopeLine && <p className="live-reference-scope">{scopeLine}</p>}
      <div className="live-reference-choice">
        <span className="live-reference-label">{r.choice}</span>
        <SegmentedControl
          label={r.choice}
          options={options}
          value={choice}
          onChange={(value) => void pick(value)}
          tone="neutral"
          size="small"
          disabledReason={demo ? r.calibrateDemo : undefined}
        />
      </div>
      <ul className="live-reference-lines">
        <li>{info.largest ? largestLine(info) : r.noLargest}</li>
        <li>{calibrationLine}</li>
      </ul>
      <form className="live-calibrate" onSubmit={(event) => void submit(event)}>
        <label className="live-calibrate-field">
          <span className="live-reference-label">{r.calibrateLabel}</span>
          <input
            type="text"
            inputMode="decimal"
            className="text-field num"
            value={text}
            maxLength={6}
            disabled={blocked !== undefined || busy}
            title={blocked}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button button--small"
          disabled={blocked !== undefined || busy || text.trim() === ''}
          title={blocked}
        >
          {r.calibrate}
        </button>
      </form>
      <p className="live-reference-hint">{r.calibrateHint}</p>
      <p className="live-reference-status" role="status">
        {status}
      </p>
    </section>
  );
}

/** One line per machine, for the machines selected in the header. */
function MachinesCard({ machines }: { machines: LiveMachine[] }) {
  const m = t.machines;
  const today = useToday();
  const status = (machine: LiveMachine) => {
    switch (machine.status) {
      case 'active':
        return machine.window ? m.active(machine.window.endAt.time) : m.idle;
      case 'noLiveData':
        return m.noLive;
      case 'needsUpdate':
        return m.needsUpdate(LIVE_MIN_VERSION);
      case 'newerApp':
        return m.newerApp;
      case 'stale':
        return machine.liveAtTime ? m.stale(when(machine.liveAtTime, today)) : m.noLive;
      case 'noData':
        return m.noData;
      case 'idle':
        return m.idle;
    }
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
