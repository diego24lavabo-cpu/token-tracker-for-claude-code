import { Bot, FolderSearch, Info } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AgentInvocation,
  AgentKindRow,
  AgentModels,
  Agents as AgentsData,
  AgentTypeRow,
  ShareItem,
  SubagentKind,
} from '../../shared/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { HBars } from '../components/HBars';
import { KpiCard } from '../components/KpiCard';
import { MainSubagentBars } from '../components/MainSubagentBars';
import { Page } from '../components/Page';
import { SessionDrawer } from '../components/SessionDrawer';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { agentKindName, agentRunLabel, agentTypeLabel } from '../lib/agents';
import { seriesColor } from '../lib/chart';
import {
  formatCost,
  formatDay,
  formatDecimal,
  formatDuration,
  formatInt,
  formatPercent,
  formatTokens,
} from '../lib/format';
import { useAppData } from '../state/appData';

const NO_VALUE = '—';
const t = en.agents;

/** The session of a top-10 row, shown in the drawer. */
interface OpenSession {
  machineId: string;
  sessionId: string;
  project: string;
}

const runKey = (run: AgentInvocation) => `${run.machineId}:${run.sessionId}:${run.agentId}`;
const typeKey = (row: { kind: SubagentKind; type: string }) => `${row.kind}:${row.type}`;

export function Agents() {
  const filters = useRangeFilters();
  const { info } = useAppData();
  const fetchAgents = useCallback(() => window.api.getAgents(filters), [filters]);
  const { data, loading } = useUsageQuery(fetchAgents);
  const [open, setOpen] = useState<(OpenSession & { run: string }) | null>(null);

  // Focus goes back where it was when the drawer closes.
  const returnFocus = useRef<HTMLElement | null>(null);
  const openRun = useCallback((run: AgentInvocation) => {
    if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    setOpen({
      machineId: run.machineId,
      sessionId: run.sessionId,
      project: run.project,
      run: runKey(run),
    });
  }, []);
  const closeSession = useCallback(() => {
    setOpen(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, []);

  if (data && !data.hasData) {
    return (
      <Page section="agents">
        <EmptyState
          icon={<FolderSearch size={22} strokeWidth={1.75} />}
          title={en.overview.empty.title}
          body={en.overview.empty.body(
            info?.logRoots[0] ?? info?.defaultLogRoot ?? '~/.claude/projects',
          )}
        />
      </Page>
    );
  }

  if (data && !data.hasSubagents) {
    return (
      <Page section="agents">
        <EmptyState
          icon={<Bot size={22} strokeWidth={1.75} />}
          title={t.empty.title}
          body={t.empty.body}
        />
      </Page>
    );
  }

  return (
    <Page section="agents">
      <KpiRow data={data} />
      <div className="agents-row">
        <DailyCard data={data} />
        <KindsCard kinds={data?.kinds} />
      </div>
      <TypesTable rows={data?.byType} loading={loading} />
      <div className="agents-row agents-row--even">
        <StartupCard data={data} />
        <ModelsCard models={data?.modelsMainVsSub} />
      </div>
      <div className={open ? 'sessions-layout has-drawer' : 'sessions-layout'}>
        <TopTable rows={data?.top} selected={open?.run ?? null} onSelect={openRun} />
        {open && (
          <SessionDrawer
            machineId={open.machineId}
            sessionId={open.sessionId}
            project={open.project}
            onClose={closeSession}
          />
        )}
      </div>
    </Page>
  );
}

function KpiRow({ data }: { data: AgentsData | null }) {
  const k = t.kpi;
  const kpis = data?.kpis;
  const sessionsHint = () => {
    if (!kpis) return NO_VALUE;
    if (kpis.sessions === 0) return k.noSessions;
    return k.sessionsHint(formatInt(kpis.sessionsWithSubagents), formatInt(kpis.sessions));
  };

  return (
    <div className="kpi-grid kpi-grid--6">
      <KpiCard
        label={k.share}
        value={kpis ? formatPercent(kpis.subagentShare) : NO_VALUE}
        hint={kpis ? k.shareHint(formatTokens(kpis.subagentTokens)) : NO_VALUE}
        title={k.shareTitle}
      />
      <KpiCard
        label={k.invocations}
        value={kpis ? formatInt(kpis.invocations) : NO_VALUE}
        hint={
          kpis?.invocationsPerSession != null
            ? k.perSession(formatDecimal(kpis.invocationsPerSession))
            : kpis
              ? k.noSessions
              : NO_VALUE
        }
        title={k.invocationsTitle}
      />
      <KpiCard
        label={k.tokens}
        value={kpis?.averageTokens != null ? formatTokens(kpis.averageTokens) : NO_VALUE}
        hint={
          kpis?.medianTokens != null
            ? k.median(formatTokens(kpis.medianTokens))
            : kpis
              ? k.none
              : NO_VALUE
        }
        title={k.tasksTitle}
      />
      <KpiCard
        label={k.startup}
        value={kpis?.averageStartup != null ? formatTokens(kpis.averageStartup) : NO_VALUE}
        hint={kpis?.averageStartup != null ? k.startupHint : kpis ? k.none : NO_VALUE}
        title={k.tasksTitle}
      />
      <KpiCard
        label={k.duration}
        value={kpis?.averageActiveMs != null ? formatDuration(kpis.averageActiveMs) : NO_VALUE}
        hint={kpis?.averageActiveMs != null ? k.durationHint : kpis ? k.none : NO_VALUE}
        title={k.tasksTitle}
      />
      <KpiCard
        label={k.sessions}
        value={
          kpis?.sessionsWithSubagentsShare != null
            ? formatPercent(kpis.sessionsWithSubagentsShare)
            : NO_VALUE
        }
        hint={sessionsHint()}
      />
    </div>
  );
}

function DailyCard({ data }: { data: AgentsData | null }) {
  const today = useToday();
  const d = t.daily;
  const empty = data !== null && data.daily.every((point) => point.main + point.subagent === 0);
  return (
    <section className="card chart-card agents-daily">
      <header className="chart-card-header">
        <h2 className="card-title">{d.title}</h2>
        <span className="chart-legend">
          <span className="chart-legend-item">
            <span className="swatch swatch--main" aria-hidden="true" />
            {d.main}
          </span>
          <span className="chart-legend-item">
            <span className="swatch swatch--subagent" aria-hidden="true" />
            {d.subagents}
          </span>
        </span>
      </header>
      <div className="chart-card-body">
        <MainSubagentBars data={data?.daily ?? []} today={today} label={d.label} />
        {empty && <p className="chart-empty">{d.empty}</p>}
      </div>
    </section>
  );
}

const KIND_CLASSES: Record<SubagentKind, string> = {
  task: 'split-part--1',
  workflow: 'split-part--3',
  aside: 'split-part--2',
  warmup: 'split-part--4',
};

function KindsCard({ kinds }: { kinds: AgentKindRow[] | undefined }) {
  const c = t.kindsCard;
  const rows = kinds ?? [];
  return (
    <section className="card chart-card agents-kinds">
      <header className="chart-card-header">
        <h2 className="card-title">{c.title}</h2>
        <span className="info-hint" title={c.info} aria-label={c.info} role="img">
          <Info size={14} strokeWidth={2} aria-hidden="true" />
        </span>
      </header>
      <div className="split-bar kinds-bar" aria-hidden="true">
        {rows
          .filter((row) => row.tokens > 0)
          .map((row) => (
            <span
              key={row.kind}
              className={`split-part ${KIND_CLASSES[row.kind]}`}
              style={{ flexGrow: row.share }}
              title={`${agentKindName(row.kind)} · ${formatTokens(row.tokens)}`}
            />
          ))}
      </div>
      <ul className="kinds-list" aria-label={c.label}>
        {rows.map((row) => (
          <li
            key={row.kind}
            className={row.runs === 0 ? 'kinds-item is-empty' : 'kinds-item'}
            title={`${t.kindDescriptions[row.kind]} · ${formatTokens(row.tokens)} tokens`}
          >
            <span className={`swatch ${KIND_CLASSES[row.kind]}`} aria-hidden="true" />
            <span className="kinds-name">
              {agentKindName(row.kind)}
              <span className="kinds-count">
                {' · '}
                {row.kind === 'warmup'
                  ? c.runs(row.runs, formatInt(row.runs))
                  : c.invocations(row.runs, formatInt(row.runs))}
              </span>
            </span>
            <span className="kinds-share num">{formatPercent(row.share)}</span>
            <span className="kinds-description">{t.kindDescriptions[row.kind]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KindBadge({ kind }: { kind: SubagentKind }) {
  return <span className={`kind-badge kind-badge--${kind}`}>{agentKindName(kind)}</span>;
}

function TypesTable({ rows, loading }: { rows: AgentTypeRow[] | undefined; loading: boolean }) {
  const c = t.types;
  const columns = useMemo((): Column<AgentTypeRow>[] => {
    const largest = (rows ?? []).reduce((max, row) => Math.max(max, row.tokens), 0);
    return [
      {
        id: 'type',
        header: c.type,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => agentTypeLabel(row.type, row.kind),
        render: (row) => (
          <span className="cell-name num" title={agentTypeLabel(row.type, row.kind)}>
            {agentTypeLabel(row.type, row.kind)}
          </span>
        ),
      },
      {
        id: 'kind',
        header: c.kind,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => agentKindName(row.kind),
        render: (row) => <KindBadge kind={row.kind} />,
      },
      {
        id: 'runs',
        header: c.runs,
        description: c.runsHint,
        sortValue: (row) => row.runs,
        render: (row) =>
          row.kind === 'warmup' ? (
            <span className="num cell-muted" title={c.warmupRuns}>
              {formatInt(row.runs)}
            </span>
          ) : (
            <span className="num">{formatInt(row.runs)}</span>
          ),
      },
      {
        id: 'tokens',
        header: c.tokens,
        align: 'start',
        sortValue: (row) => row.tokens,
        render: (row) => (
          <span className="cell-share" title={formatPercent(row.share)}>
            <span className="cell-share-track" aria-hidden="true">
              <span
                className="cell-share-fill"
                style={{ width: `${largest > 0 ? (row.tokens / largest) * 100 : 0}%` }}
              />
            </span>
            <span className="num">{formatTokens(row.tokens)}</span>
          </span>
        ),
      },
      {
        id: 'perRun',
        header: c.perRun,
        description: c.perRunHint,
        sortValue: (row) => row.averageTokens,
        render: (row) => <span className="num">{formatTokens(row.averageTokens)}</span>,
      },
      {
        id: 'startup',
        header: c.startup,
        description: c.startupHint,
        sortValue: (row) => row.averageStartup,
        render: (row) => <span className="num">{formatTokens(row.averageStartup)}</span>,
      },
      {
        id: 'duration',
        header: c.duration,
        description: c.durationHint,
        sortValue: (row) => row.averageActiveMs,
        render: (row) => <span className="num">{formatDuration(row.averageActiveMs)}</span>,
      },
      {
        id: 'calls',
        header: c.calls,
        sortValue: (row) => row.averageCalls,
        render: (row) => <span className="num">{formatDecimal(row.averageCalls)}</span>,
      },
      {
        id: 'output',
        header: c.output,
        description: c.outputHint,
        sortValue: (row) => row.outputShare,
        render: (row) => (
          <span className="num">{formatPercent(row.outputShare, { precise: true })}</span>
        ),
      },
      {
        id: 'model',
        header: c.model,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => row.mainModel,
        render: (row) => <span className="cell-accent">{row.mainModel || NO_VALUE}</span>,
      },
      {
        id: 'cost',
        header: c.cost,
        sortValue: (row) => row.cost,
        render: (row) => <span className="num">{formatCost(row.cost)}</span>,
      },
    ];
  }, [rows, c]);

  return (
    <section
      className={
        loading ? 'card table-card agents-types is-loading' : 'card table-card agents-types'
      }
      aria-busy={loading}
    >
      <header className="table-card-header">
        <div>
          <h2 className="card-title">{c.title}</h2>
          <p className="card-hint">{c.hint}</p>
        </div>
      </header>
      <DataTable
        label={c.label}
        columns={columns}
        rows={rows ?? []}
        rowKey={typeKey}
        initialSort={{ column: 'tokens', direction: 'desc' }}
        emptyText={rows ? c.empty : NO_VALUE}
      />
    </section>
  );
}

function StartupCard({ data }: { data: AgentsData | null }) {
  const s = t.startup;
  const rows = data?.startupByType ?? [];
  const largest = rows.reduce((max, row) => Math.max(max, row.averageStartup), 0);
  return (
    <section className="card chart-card agents-startup">
      <header className="chart-card-header chart-card-header--stacked">
        <h2 className="card-title">{s.title}</h2>
        <p className="card-hint">{s.hint}</p>
      </header>
      {data && rows.length === 0 ? (
        <p className="panel-empty">{s.empty}</p>
      ) : (
        <HBars
          label={s.label}
          items={rows.map((row) => {
            const type = agentTypeLabel(row.type, row.kind);
            const label = row.kind === 'workflow' ? s.workflow(type) : type;
            const tokens = formatTokens(row.averageStartup);
            return {
              key: typeKey(row),
              label,
              tokens: row.averageStartup,
              share: largest > 0 ? row.averageStartup / largest : 0,
              value: tokens,
              title: s.item(label, tokens, row.runs),
            };
          })}
        />
      )}
    </section>
  );
}

function ModelsCard({ models }: { models: AgentModels | undefined }) {
  const m = t.models;
  const order = models?.models ?? [];
  const color = (name: string) => seriesColor(Math.max(0, order.indexOf(name)));
  return (
    <section className="card chart-card agents-models" aria-label={m.label}>
      <header className="chart-card-header">
        <h2 className="card-title">{m.title}</h2>
      </header>
      <ModelBar title={m.main} items={models?.main} color={color} />
      <ModelBar title={m.subagents} items={models?.subagents} color={color} />
      {order.length > 0 && (
        <ul className="split-legend">
          {order.map((name) => (
            <li key={name} className="split-legend-item">
              <span className="swatch" style={{ background: color(name) }} aria-hidden="true" />
              {name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ModelBarProps {
  title: string;
  items: ShareItem[] | undefined;
  color: (name: string) => string;
}

function ModelBar({ title, items, color }: ModelBarProps) {
  const list = items ?? [];
  return (
    <div className="model-bar" role="group" aria-label={title}>
      <h3 className="panel-block-title">{title}</h3>
      <div className="split-bar" aria-hidden="true">
        {list.map((item) => (
          <span
            key={item.name}
            className="split-part"
            style={{ flexGrow: item.share, background: color(item.name) }}
            title={`${item.name} · ${formatTokens(item.tokens)} · ${formatPercent(item.share)}`}
          />
        ))}
      </div>
      <p className="model-bar-shares num">
        {items && list.length === 0
          ? t.models.none
          : list.map((item) => `${item.name} ${formatPercent(item.share)}`).join(' · ') || NO_VALUE}
      </p>
    </div>
  );
}

interface TopTableProps {
  rows: AgentInvocation[] | undefined;
  selected: string | null;
  onSelect: (run: AgentInvocation) => void;
}

function TopTable({ rows, selected, onSelect }: TopTableProps) {
  const today = useToday();
  const c = t.top;
  const columns = useMemo((): Column<AgentInvocation>[] => {
    const year = today.slice(0, 4);
    return [
      {
        id: 'date',
        header: c.date,
        align: 'start',
        sortValue: (row) => row.start,
        render: (row) => (
          <span className="num cell-start">
            {c.dateCell(
              formatDay(row.startDay, { year: row.startDay.slice(0, 4) !== year }),
              row.startTime,
            )}
          </span>
        ),
      },
      {
        id: 'project',
        header: c.project,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => row.project,
        render: (row) => (
          <span className="cell-name num" title={row.project}>
            {row.project}
          </span>
        ),
      },
      {
        id: 'type',
        header: c.type,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => agentRunLabel(row.agentId, row.type, row.kind),
        render: (row) => (
          <span className="cell-type">
            <span className="cell-accent num">
              {agentRunLabel(row.agentId, row.type, row.kind)}
            </span>
            {row.kind !== 'task' && <KindBadge kind={row.kind} />}
          </span>
        ),
      },
      {
        id: 'model',
        header: c.model,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => row.model,
        render: (row) => <span>{row.model || NO_VALUE}</span>,
      },
      {
        id: 'duration',
        header: c.duration,
        description: c.durationHint,
        sortValue: (row) => row.activeMs,
        render: (row) => <span className="num">{formatDuration(row.activeMs)}</span>,
      },
      {
        id: 'calls',
        header: c.calls,
        sortValue: (row) => row.calls,
        render: (row) => <span className="num">{formatInt(row.calls)}</span>,
      },
      {
        id: 'startup',
        header: c.startup,
        description: c.startupHint,
        sortValue: (row) => row.startupInput,
        render: (row) => <span className="num">{formatTokens(row.startupInput)}</span>,
      },
      {
        id: 'tokens',
        header: c.tokens,
        sortValue: (row) => row.tokens,
        render: (row) => <span className="num">{formatTokens(row.tokens)}</span>,
      },
    ];
  }, [today, c]);

  return (
    <section className="card table-card agents-top">
      <header className="table-card-header">
        <div>
          <h2 className="card-title">{c.title}</h2>
          <p className="card-hint">{c.hint}</p>
        </div>
      </header>
      <DataTable
        label={c.label}
        columns={columns}
        rows={rows ?? []}
        rowKey={runKey}
        initialSort={{ column: 'tokens', direction: 'desc' }}
        onSelect={onSelect}
        selectedKey={selected}
        emptyText={rows ? c.empty : NO_VALUE}
      />
    </section>
  );
}
