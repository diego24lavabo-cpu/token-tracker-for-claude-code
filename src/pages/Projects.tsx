import { FolderSearch, Search } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type {
  Filters,
  ProjectDetail,
  ProjectRow,
  Projects as ProjectsData,
} from '../../shared/types';
import { subfolderOf } from '../../shared/projects';
import { DataTable, type Column, type SortState } from '../components/DataTable';
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
import { sortRows } from '../lib/sort';
import { useAppData } from '../state/appData';

const NO_VALUE = '—';
const t = en.projects;

export function Projects() {
  const filters = useRangeFilters();
  const { info } = useAppData();
  const fetchProjects = useCallback(() => window.api.getProjects(filters), [filters]);
  const { data } = useUsageQuery(fetchProjects);
  const [selected, setSelected] = useState<Selection | null>(null);

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
  // The selection survives a change of period while it is still in the table.
  const first = rows[0];
  const current =
    selected && isSelectable(rows, selected)
      ? selected
      : first
        ? { project: first.name, folder: first.children !== undefined }
        : null;

  return (
    <Page section="projects">
      <KpiRow data={data} />
      <div className="projects-layout">
        <ProjectsTable
          rows={rows}
          loaded={data !== null}
          selected={current}
          onSelect={setSelected}
        />
        {current !== null && (
          <ProjectPanel
            selection={current}
            label={selectionLabel(current, rows)}
            filters={filters}
          />
        )}
      </div>
    </Page>
  );
}

/** A row of the table: a whole container folder, or one project. */
interface Selection {
  project: string;
  folder: boolean;
}

const selectionKey = (selection: Selection) =>
  `${selection.folder ? 'folder' : 'project'}:${selection.project}`;

function isSelectable(rows: readonly ProjectRow[], selection: Selection): boolean {
  return rows.some((row) =>
    selection.folder
      ? row.children !== undefined && row.name === selection.project
      : row.children
        ? row.children.some((child) => child.name === selection.project)
        : row.name === selection.project,
  );
}

/** The name shown for a project: a folder's own top-level usage is "<folder> (root)". */
function selectionLabel(selection: Selection, rows?: readonly ProjectRow[]): string {
  if (selection.folder) return selection.project;
  const isRoot = rows?.some((row) => row.children !== undefined && row.name === selection.project);
  return isRoot ? t.table.root(selection.project) : selection.project;
}

/** One line of the table, top level or nested under a container folder. */
interface TableLine {
  key: string;
  row: ProjectRow;
  /** Set on a subfolder line: the folder it belongs to. */
  parent: ProjectRow | null;
  /** What the first column shows. */
  label: string;
  selection: Selection;
}

function lineOf(row: ProjectRow, parent: ProjectRow | null): TableLine {
  const selection = { project: row.name, folder: parent === null && row.children !== undefined };
  let label = row.name;
  if (parent) label = row.name === parent.name ? t.table.root(row.name) : subfolderOf(row.name);
  return { key: selectionKey(selection), row, parent, label, selection };
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
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}

const INITIAL_SORT: SortState = { column: 'tokens', direction: 'desc' };

function ProjectsTable({ rows, loaded, selected, onSelect }: ProjectsTableProps) {
  const today = useToday();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(INITIAL_SORT);
  // Container folders whose subfolders are shown. Collapsed by default.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const c = t.table;

  const columns = useMemo((): Column<TableLine>[] => {
    const largest = rows.reduce((max, row) => Math.max(max, row.tokens), 0);
    return [
      {
        id: 'name',
        header: c.project,
        align: 'start',
        className: 'col-name',
        firstDirection: 'asc',
        sortValue: (line) => line.label,
        render: (line) => (
          <span className="cell-name num" title={line.row.name}>
            {line.label}
            {line.row.children && (
              <span className="cell-muted"> · {c.subfolders(countSubfolders(line.row))}</span>
            )}
          </span>
        ),
      },
      {
        id: 'tokens',
        header: c.tokens,
        align: 'start',
        sortValue: (line) => line.row.tokens,
        render: ({ row }) => (
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
        sortValue: ({ row }) => row.input,
        render: ({ row }) => <span className="num">{formatTokens(row.input)}</span>,
      },
      {
        id: 'output',
        header: c.output,
        sortValue: ({ row }) => row.output,
        render: ({ row }) => <span className="num">{formatTokens(row.output)}</span>,
      },
      {
        id: 'outIn',
        header: c.outIn,
        sortValue: ({ row }) => row.outputInputRatio,
        render: ({ row }) => (
          <span className="num">{formatPercent(row.outputInputRatio, { precise: true })}</span>
        ),
      },
      {
        id: 'subagents',
        header: c.subagents,
        sortValue: ({ row }) => row.subagentShare,
        render: ({ row }) => (
          <span className="num cell-accent">{formatPercent(row.subagentShare)}</span>
        ),
      },
      {
        id: 'sessions',
        header: c.sessions,
        description: c.sessionsHint,
        sortValue: ({ row }) => row.sessions,
        render: ({ row }) => <span className="num">{formatInt(row.sessions)}</span>,
      },
      {
        id: 'perSession',
        header: c.perSession,
        sortValue: ({ row }) => row.tokensPerSession,
        render: ({ row }) => (
          <span className="num">
            {row.tokensPerSession === null ? NO_VALUE : formatTokens(row.tokensPerSession)}
          </span>
        ),
      },
      {
        id: 'activeDays',
        header: c.activeDays,
        sortValue: ({ row }) => row.activeDays,
        render: ({ row }) => <span className="num">{formatInt(row.activeDays)}</span>,
      },
      {
        id: 'mainModel',
        header: c.mainModel,
        align: 'start',
        firstDirection: 'asc',
        sortValue: ({ row }) => row.mainModel,
        render: ({ row }) => <span className="cell-accent">{row.mainModel || NO_VALUE}</span>,
      },
      {
        id: 'lastUsed',
        header: c.lastUsed,
        sortValue: ({ row }) => row.lastUsed,
        render: ({ row }) => (
          <span className="cell-muted">{formatRelativeDay(row.lastUsed, today)}</span>
        ),
      },
    ];
  }, [rows, today, c]);

  // Top-level rows and container folders sort by the chosen column, subfolders within
  // their folder. A search that matches a subfolder shows it inside its open folder.
  const lines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (line: TableLine) => line.label.toLowerCase().includes(needle);
    const column = columns.find((candidate) => candidate.id === sort.column);
    const order = (list: TableLine[]) =>
      column?.sortValue ? sortRows(list, column.sortValue, sort.direction) : list;

    const result: { line: TableLine; open: boolean }[] = [];
    for (const top of order(rows.map((row) => lineOf(row, null)))) {
      const children = top.row.children?.map((child) => lineOf(child, top.row)) ?? [];
      const folderMatches = !needle || matches(top);
      const matchingChildren = needle ? children.filter(matches) : children;
      if (!folderMatches && matchingChildren.length === 0) continue;

      const searchOpens = needle !== '' && matchingChildren.length > 0;
      const open = children.length > 0 && (searchOpens || expanded.has(top.row.name));
      result.push({ line: top, open });
      if (open) {
        const shown = searchOpens && !folderMatches ? matchingChildren : children;
        for (const child of order(shown)) result.push({ line: child, open: false });
      }
    }
    return result;
  }, [rows, query, sort, columns, expanded]);

  const openByKey = useMemo(
    () => new Map(lines.map(({ line, open }) => [line.key, open])),
    [lines],
  );

  const toggle = (folder: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

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
        rows={lines.map(({ line }) => line)}
        rowKey={(line) => line.key}
        sort={sort}
        onSortChange={setSort}
        onSelect={(line) => onSelect(line.selection)}
        selectedKey={selected ? selectionKey(selected) : null}
        rowClassName={(line) =>
          line.parent ? 'is-child' : line.row.children ? 'is-folder' : undefined
        }
        rowPrefix={(line) => {
          if (!line.row.children || line.parent) {
            return <span className="row-toggle-space" aria-hidden="true" />;
          }
          const open = openByKey.get(line.key) === true;
          const name = line.row.name;
          return (
            <button
              type="button"
              className="row-toggle"
              aria-expanded={open}
              aria-label={open ? c.collapse(name) : c.expand(name)}
              title={open ? c.collapse(name) : c.expand(name)}
              onClick={(event) => {
                event.stopPropagation();
                toggle(name);
              }}
            >
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            </button>
          );
        }}
        emptyText={!loaded ? NO_VALUE : query.trim() ? c.noMatch(query.trim()) : c.empty}
      />
    </section>
  );
}

/** Subfolders of a container folder row, its own top-level usage left out. */
function countSubfolders(row: ProjectRow): number {
  return (row.children ?? []).filter((child) => child.name !== row.name).length;
}

interface ProjectPanelProps {
  selection: Selection;
  label: string;
  filters: Filters;
}

function ProjectPanel({ selection, label, filters }: ProjectPanelProps) {
  const today = useToday();
  const { project, folder } = selection;
  const fetchDetail = useCallback(
    () => window.api.getProjectDetail(project, filters, folder),
    [project, folder, filters],
  );
  const { data, loading } = useUsageQuery(fetchDetail);
  const p = t.panel;

  return (
    <section
      className={loading ? 'card project-panel is-loading' : 'card project-panel'}
      aria-label={p.label(label)}
      aria-busy={loading}
    >
      <header className="project-panel-header">
        <h2 className="card-title">
          {p.title} · <span className="project-panel-name num">{label}</span>
          {folder && <span className="cell-muted"> · {p.wholeFolder}</span>}
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
