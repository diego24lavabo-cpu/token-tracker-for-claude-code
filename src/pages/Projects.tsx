import { FolderSearch, Search } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type {
  Filters,
  ProjectDetail,
  ProjectRow,
  Projects as ProjectsData,
} from '../../shared/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { HBars } from '../components/HBars';
import { HourBars } from '../components/HourBars';
import { KpiCard } from '../components/KpiCard';
import { MainSubagentBars } from '../components/MainSubagentBars';
import { Page } from '../components/Page';
import { SplitBar } from '../components/SplitBar';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { agentKindLabel, agentTypeLabel } from '../lib/agents';
import {
  formatCost,
  formatInt,
  formatPercent,
  formatRelativeDay,
  formatTokens,
} from '../lib/format';
import { useAppData } from '../state/appData';

const NO_VALUE = '—';
const t = en.projects;

export function Projects() {
  const filters = useRangeFilters();
  const { info } = useAppData();
  const fetchProjects = useCallback(() => window.api.getProjects(filters), [filters]);
  const { data } = useUsageQuery(fetchProjects);
  const [selected, setSelected] = useState<string | null>(null);

  if (data && !data.hasData) {
    return (
      <Page section="projects">
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

  const rows = data?.rows ?? [];
  // The selection survives a change of period while the project is still in the table.
  const current = rows.some((row) => row.name === selected) ? selected : (rows[0]?.name ?? null);

  return (
    <Page section="projects">
      <KpiRow data={data} />
      <div className="projects-layout">
        <ProjectsTable
          rows={rows}
          loaded={data !== null}
          selected={current}
          onSelect={(row) => setSelected(row.name)}
        />
        {current !== null && <ProjectPanel project={current} filters={filters} />}
      </div>
    </Page>
  );
}

function KpiRow({ data }: { data: ProjectsData | null }) {
  const kpis = data?.kpis;
  const k = t.kpi;
  const ratio = kpis?.outputInputRatio ?? 0;

  return (
    <div className="kpi-grid kpi-grid--5">
      <KpiCard
        label={k.active}
        value={kpis ? formatInt(kpis.activeProjects) : NO_VALUE}
        hint={k.activeHint}
      />
      <KpiCard
        label={k.main}
        value={kpis?.mainProject?.name ?? NO_VALUE}
        hint={kpis?.mainProject ? k.mainHint(formatPercent(kpis.mainProject.share)) : NO_VALUE}
      />
      <KpiCard
        label={k.perSession}
        value={kpis?.tokensPerSession != null ? formatTokens(kpis.tokensPerSession) : NO_VALUE}
        hint={k.perSessionHint}
      />
      <KpiCard
        label={k.ratio}
        value={kpis && ratio > 0 ? formatPercent(ratio, { precise: true }) : NO_VALUE}
        hint={ratio > 0 ? k.ratioHint(formatInt(Math.round(1 / ratio))) : NO_VALUE}
      />
      <KpiCard
        label={k.top3}
        value={kpis && kpis.activeProjects > 0 ? formatPercent(kpis.top3Share) : NO_VALUE}
        hint={k.top3Hint}
      />
    </div>
  );
}

interface ProjectsTableProps {
  rows: ProjectRow[];
  loaded: boolean;
  selected: string | null;
  onSelect: (row: ProjectRow) => void;
}

function ProjectsTable({ rows, loaded, selected, onSelect }: ProjectsTableProps) {
  const today = useToday();
  const [query, setQuery] = useState('');
  const c = t.table;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows;
  }, [rows, query]);

  const columns = useMemo((): Column<ProjectRow>[] => {
    const largest = rows.reduce((max, row) => Math.max(max, row.tokens), 0);
    return [
      {
        id: 'name',
        header: c.project,
        align: 'start',
        className: 'col-name',
        firstDirection: 'asc',
        sortValue: (row) => row.name,
        render: (row) => (
          <span className="cell-name num" title={row.name}>
            {row.name}
          </span>
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
        id: 'input',
        header: c.input,
        sortValue: (row) => row.input,
        render: (row) => <span className="num">{formatTokens(row.input)}</span>,
      },
      {
        id: 'output',
        header: c.output,
        sortValue: (row) => row.output,
        render: (row) => <span className="num">{formatTokens(row.output)}</span>,
      },
      {
        id: 'outIn',
        header: c.outIn,
        sortValue: (row) => row.outputInputRatio,
        render: (row) => (
          <span className="num">{formatPercent(row.outputInputRatio, { precise: true })}</span>
        ),
      },
      {
        id: 'subagents',
        header: c.subagents,
        sortValue: (row) => row.subagentShare,
        render: (row) => (
          <span className="num cell-accent">{formatPercent(row.subagentShare)}</span>
        ),
      },
      {
        id: 'sessions',
        header: c.sessions,
        description: c.sessionsHint,
        sortValue: (row) => row.sessions,
        render: (row) => <span className="num">{formatInt(row.sessions)}</span>,
      },
      {
        id: 'perSession',
        header: c.perSession,
        sortValue: (row) => row.tokensPerSession,
        render: (row) => (
          <span className="num">
            {row.tokensPerSession === null ? NO_VALUE : formatTokens(row.tokensPerSession)}
          </span>
        ),
      },
      {
        id: 'activeDays',
        header: c.activeDays,
        sortValue: (row) => row.activeDays,
        render: (row) => <span className="num">{formatInt(row.activeDays)}</span>,
      },
      {
        id: 'mainModel',
        header: c.mainModel,
        align: 'start',
        firstDirection: 'asc',
        sortValue: (row) => row.mainModel,
        render: (row) => <span className="cell-accent">{row.mainModel || NO_VALUE}</span>,
      },
      {
        id: 'lastUsed',
        header: c.lastUsed,
        sortValue: (row) => row.lastUsed,
        render: (row) => (
          <span className="cell-muted">{formatRelativeDay(row.lastUsed, today)}</span>
        ),
      },
    ];
  }, [rows, today, c]);

  return (
    <section className="card table-card projects-table">
      <header className="table-card-header">
        <div>
          <h2 className="card-title">{c.title}</h2>
          <p className="card-hint">{c.hint}</p>
        </div>
        <label className="search-field">
          <Search size={14} strokeWidth={2} aria-hidden="true" />
          <span className="visually-hidden">{c.search}</span>
          <input
            type="search"
            value={query}
            placeholder={c.searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      <DataTable
        label={c.label}
        columns={columns}
        rows={visible}
        rowKey={(row) => row.name}
        initialSort={{ column: 'tokens', direction: 'desc' }}
        onSelect={onSelect}
        selectedKey={selected}
        emptyText={!loaded ? NO_VALUE : query.trim() ? c.noMatch(query.trim()) : c.empty}
      />
    </section>
  );
}

function ProjectPanel({ project, filters }: { project: string; filters: Filters }) {
  const today = useToday();
  const fetchDetail = useCallback(
    () => window.api.getProjectDetail(project, filters),
    [project, filters],
  );
  const { data, loading } = useUsageQuery(fetchDetail);
  const p = t.panel;

  return (
    <section
      className={loading ? 'card project-panel is-loading' : 'card project-panel'}
      aria-label={p.label(project)}
      aria-busy={loading}
    >
      <header className="project-panel-header">
        <h2 className="card-title">
          {p.title} · <span className="project-panel-name num">{project}</span>
        </h2>
        <Summary detail={data} />
      </header>
      <div className="project-panel-grid">
        <div className="panel-block panel-block--daily">
          <h3 className="panel-block-title">
            {p.daily}
            <span className="chart-legend">
              <span className="chart-legend-item">
                <span className="swatch swatch--main" aria-hidden="true" />
                {p.main}
              </span>
              <span className="chart-legend-item">
                <span className="swatch swatch--subagent" aria-hidden="true" />
                {p.subagents}
              </span>
            </span>
          </h3>
          <div className="chart-card-body panel-chart panel-chart--daily">
            <MainSubagentBars data={data?.daily ?? []} today={today} label={p.dailyLabel} />
            {data && data.summary.tokens === 0 && <p className="chart-empty">{p.noUsage}</p>}
          </div>
        </div>

        <div className="panel-block panel-block--side">
          <div>
            <h3 className="panel-block-title">{p.models}</h3>
            <HBars
              label={p.modelsLabel}
              items={(data?.models ?? []).map((model) => ({
                key: model.name,
                label: model.name,
                tokens: model.tokens,
                share: model.share,
              }))}
            />
          </div>
          <div>
            <h3 className="panel-block-title">{p.machines}</h3>
            <SplitBar
              label={p.machinesLabel}
              parts={(data?.machines ?? []).map((machine) => ({
                key: machine.id,
                label: machine.name,
                tokens: machine.tokens,
                share: machine.share,
              }))}
            />
          </div>
        </div>

        <div className="panel-block panel-block--hours">
          <h3 className="panel-block-title">{p.hours}</h3>
          <div className="chart-card-body panel-chart panel-chart--hours">
            <HourBars hours={data?.hours ?? []} label={p.hoursLabel} />
          </div>
        </div>

        <div className="panel-block panel-block--agents">
          <h3 className="panel-block-title">{p.agentTypes}</h3>
          {data && data.agentTypes.length === 0 ? (
            <p className="panel-empty">{p.noAgents}</p>
          ) : (
            <HBars
              label={p.agentTypesLabel}
              items={(data?.agentTypes ?? []).slice(0, 6).map((type) => ({
                key: `${type.kind}:${type.name}`,
                label: agentTypeLabel(type.name, type.kind),
                detail:
                  type.kind === 'warmup'
                    ? agentKindLabel(type.kind)
                    : `${agentKindLabel(type.kind)} · ${p.invocations(type.invocations, formatInt(type.invocations))}`,
                tokens: type.tokens,
                share: type.share,
              }))}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function Summary({ detail }: { detail: ProjectDetail | null }) {
  if (!detail) return <p className="project-panel-summary num">{NO_VALUE}</p>;
  const s = t.panel.summary;
  const { summary } = detail;
  const parts = [
    s.tokens(formatTokens(summary.tokens)),
    s.sessions(summary.sessions, formatInt(summary.sessions)),
    s.output(formatPercent(summary.outputShare)),
    s.subagents(formatPercent(summary.subagentShare)),
    s.cost(formatCost(summary.cost)),
  ];
  return (
    <p
      className="project-panel-summary num"
      title={summary.costIsPartial ? s.costPartial : undefined}
    >
      {parts.join(' · ')}
    </p>
  );
}
