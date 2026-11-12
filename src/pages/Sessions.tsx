import { ChevronDown, ChevronLeft, ChevronRight, FolderSearch, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isDay } from '../../shared/period';
import type {
  SessionFilters,
  SessionRow,
  Sessions as SessionsData,
  SessionSort,
  SessionSortKey,
} from '../../shared/types';
import { CategoryBars, type CategoryItem } from '../components/CategoryBars';
import { DataTable, type Column, type SortState } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { KpiCard } from '../components/KpiCard';
import { Page } from '../components/Page';
import { SessionDrawer } from '../components/SessionDrawer';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import {
  formatCost,
  formatDay,
  formatDecimal,
  formatDuration,
  formatInt,
  formatTokens,
} from '../lib/format';
import { SESSIONS_DAY_PARAM } from '../routes';
import { useAppData } from '../state/appData';

const NO_VALUE = '—';
const t = en.sessions;
const DEFAULT_SORT: SessionSort = { key: 'start', direction: 'desc' };

/** The session shown in the drawer. */
interface OpenSession {
  machineId: string;
  sessionId: string;
  project: string;
}

const rowKey = (row: { machineId: string; id: string }) => `${row.machineId}:${row.id}`;

export function Sessions() {
  const range = useRangeFilters();
  const { info } = useAppData();
  const [searchParams, setSearchParams] = useSearchParams();
  const dayParam = searchParams.get(SESSIONS_DAY_PARAM);
  const day = dayParam !== null && isDay(dayParam) ? dayParam : null;
  const [project, setProject] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [sort, setSort] = useState<SessionSort>(DEFAULT_SORT);
  const [open, setOpen] = useState<OpenSession | null>(null);

  const filters = useMemo((): SessionFilters => {
    const value: SessionFilters = { ...range };
    if (day) value.day = day;
    if (project !== null) value.projects = [project];
    if (model !== null) value.models = [model];
    return value;
  }, [range, day, project, model]);

  // Any other question starts again from the first page.
  const question = JSON.stringify([filters, sort]);
  const [paging, setPaging] = useState({ question, page: 0 });
  const page = paging.question === question ? paging.page : 0;

  const fetchSessions = useCallback(
    () => window.api.getSessions(filters, page, sort),
    [filters, page, sort],
  );
  const { data, loading } = useUsageQuery(fetchSessions);

  const removeDay = useCallback(() => {
    setSearchParams(
      (params) => {
        params.delete(SESSIONS_DAY_PARAM);
        return params;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // Focus goes back where it was when the drawer closes.
  const returnFocus = useRef<HTMLElement | null>(null);
  const openSession = useCallback((row: SessionRow) => {
    if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    setOpen({ machineId: row.machineId, sessionId: row.id, project: row.project });
  }, []);
  const closeSession = useCallback(() => {
    setOpen(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, []);

  const periodIgnored = day ? t.filters.dayIgnoresPeriod : undefined;

  if (data && !data.hasData) {
    return (
      <Page section="sessions" periodIgnored={periodIgnored}>
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

  return (
    <Page section="sessions" periodIgnored={periodIgnored}>
      <FilterBar
        day={day}
        onRemoveDay={removeDay}
        project={project}
        projects={data?.projects ?? []}
        onProject={setProject}
        model={model}
        models={data?.models ?? []}
        onModel={setModel}
      />
      <KpiRow data={data} />
      <div className="sessions-charts">
        <HistogramCard
          title={t.size.title}
          label={t.size.label}
          bins={t.size.bins}
          titles={t.size.titles}
          counts={data?.sizeHist}
        />
        <HistogramCard
          title={t.duration.title}
          hint={t.duration.hint}
          label={t.duration.label}
          bins={t.duration.bins}
          titles={t.duration.titles}
          counts={data?.durationHist}
        />
      </div>
      <div className={open ? 'sessions-layout has-drawer' : 'sessions-layout'}>
        <SessionsTable
          data={data}
          loading={loading}
          day={day}
          filtered={project !== null || model !== null}
          sort={sort}
          onSort={setSort}
          onPage={(next) => setPaging({ question, page: next })}
          selected={open ? rowKey({ machineId: open.machineId, id: open.sessionId }) : null}
          onSelect={openSession}
        />
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

interface FilterBarProps {
  day: string | null;
  onRemoveDay: () => void;
  project: string | null;
  projects: string[];
  onProject: (project: string | null) => void;
  model: string | null;
  models: string[];
  onModel: (model: string | null) => void;
}

function FilterBar({
  day,
  onRemoveDay,
  project,
  projects,
  onProject,
  model,
  models,
  onModel,
}: FilterBarProps) {
  const f = t.filters;
  return (
    <div className="filter-bar" role="group" aria-label={f.label}>
      {day && (
        <span className="filter-chip">
          <span className="num">{f.day(formatDay(day, { weekday: true, year: true }))}</span>
          <button
            type="button"
            className="filter-chip-remove"
            aria-label={f.removeDay}
            title={f.removeDay}
            onClick={onRemoveDay}
          >
            <X size={12} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </span>
      )}
      <SelectField
        label={f.project}
        allLabel={f.allProjects}
        value={project}
        options={projects}
        onChange={onProject}
      />
      <SelectField
        label={f.model}
        allLabel={f.allModels}
        value={model}
        options={models}
        onChange={onModel}
      />
      {(project !== null || model !== null) && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => {
            onProject(null);
            onModel(null);
          }}
        >
          {f.clear}
        </button>
      )}
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  allLabel: string;
  value: string | null;
  options: string[];
  onChange: (value: string | null) => void;
}

function SelectField({ label, allLabel, value, options, onChange }: SelectFieldProps) {
  // A choice stays listed even when the period no longer has it, so the menu shows it.
  const list = value !== null && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className={value === null ? 'select-field' : 'select-field is-active'}>
      <span className="select-field-label">{label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">{allLabel}</option>
        {list.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
    </label>
  );
}

function KpiRow({ data }: { data: SessionsData | null }) {
  const today = useToday();
  const k = t.kpi;
  const kpis = data?.kpis;
  const hasSessions = (kpis?.sessions ?? 0) > 0;
  const biggest = kpis?.biggest;

  return (
    <div className="kpi-grid kpi-grid--5">
      <KpiCard
        label={k.sessions}
        value={kpis ? formatInt(kpis.sessions) : NO_VALUE}
        hint={
          kpis?.sessionsPerActiveDay != null
            ? k.perActiveDay(formatDecimal(kpis.sessionsPerActiveDay))
            : kpis
              ? k.none
              : NO_VALUE
        }
      />
      <KpiCard
        label={k.duration}
        value={kpis?.averageActiveMs != null ? formatDuration(kpis.averageActiveMs) : NO_VALUE}
        hint={
          kpis?.medianActiveMs != null ? k.median(formatDuration(kpis.medianActiveMs)) : NO_VALUE
        }
        title={k.durationHint}
      />
      <KpiCard
        label={k.tokens}
        value={kpis?.averageTokens != null ? formatTokens(kpis.averageTokens) : NO_VALUE}
        hint={kpis?.medianTokens != null ? k.median(formatTokens(kpis.medianTokens)) : NO_VALUE}
      />
      <KpiCard
        label={k.messages}
        value={kpis?.averageMessages != null ? formatDecimal(kpis.averageMessages) : NO_VALUE}
        hint={hasSessions ? k.messagesHint : NO_VALUE}
      />
      <KpiCard
        label={k.biggest}
        value={biggest ? formatTokens(biggest.tokens) : NO_VALUE}
        hint={
          biggest
            ? k.biggestHint(
                biggest.project,
                formatDay(biggest.day, { year: biggest.day.slice(0, 4) !== today.slice(0, 4) }),
              )
            : kpis
              ? k.none
              : NO_VALUE
        }
      />
    </div>
  );
}

interface HistogramCardProps {
  title: string;
  hint?: string;
  label: string;
  bins: readonly string[];
  titles: readonly string[];
  counts: number[] | undefined;
}

function HistogramCard({ title, hint, label, bins, titles, counts }: HistogramCardProps) {
  const items: CategoryItem[] = useMemo(
    () =>
      bins.map((bin, index) => ({
        key: bin,
        label: bin,
        title: titles[index] ?? bin,
        value: counts?.[index] ?? 0,
      })),
    [bins, titles, counts],
  );
  return (
    <section className="card chart-card sessions-chart">
      <header className="chart-card-header">
        <h2 className="card-title">{title}</h2>
        {hint && <span className="chart-card-hint">{hint}</span>}
      </header>
      <div className="chart-card-body">
        <CategoryBars
          items={items}
          label={label}
          shareLabel={t.histogram.share}
          valueLabel={t.histogram.sessions}
          formatValue={formatInt}
        />
      </div>
    </section>
  );
}

interface SessionsTableProps {
  data: SessionsData | null;
  loading: boolean;
  day: string | null;
  filtered: boolean;
  sort: SessionSort;
  onSort: (sort: SessionSort) => void;
  onPage: (page: number) => void;
  selected: string | null;
  onSelect: (row: SessionRow) => void;
}

function SessionsTable({
  data,
  loading,
  day,
  filtered,
  sort,
  onSort,
  onPage,
  selected,
  onSelect,
}: SessionsTableProps) {
  const today = useToday();
  const c = t.table;

  const columns = useMemo((): Column<SessionRow>[] => {
    const year = today.slice(0, 4);
    return [
      {
        id: 'start',
        header: c.start,
        align: 'start',
        sortable: true,
        render: (row) => (
          <span className="num cell-start">
            {c.startCell(
              formatDay(row.startDay, { year: row.startDay.slice(0, 4) !== year }),
              row.startTime,
            )}
          </span>
        ),
      },
      {
        id: 'machine',
        header: c.machine,
        align: 'start',
        sortable: true,
        firstDirection: 'asc',
        render: (row) => <span className="cell-muted">{row.machine}</span>,
      },
      {
        id: 'project',
        header: c.project,
        align: 'start',
        sortable: true,
        firstDirection: 'asc',
        render: (row) => (
          <span className="cell-name num" title={row.project}>
            {row.project}
          </span>
        ),
      },
      {
        id: 'model',
        header: c.model,
        align: 'start',
        sortable: true,
        firstDirection: 'asc',
        render: (row) => <span className="cell-accent">{row.model || NO_VALUE}</span>,
      },
      {
        id: 'duration',
        header: c.duration,
        description: c.durationHint,
        sortable: true,
        render: (row) => <span className="num">{formatDuration(row.activeMs)}</span>,
      },
      {
        id: 'messages',
        header: c.messages,
        description: c.messagesHint,
        sortable: true,
        render: (row) => <span className="num">{formatInt(row.messages)}</span>,
      },
      {
        id: 'subagents',
        header: c.subagents,
        description: c.subagentsHint,
        sortable: true,
        render: (row) => (
          <span className={row.subagents > 0 ? 'num cell-accent' : 'num cell-muted'}>
            {formatInt(row.subagents)}
          </span>
        ),
      },
      {
        id: 'input',
        header: c.input,
        sortable: true,
        render: (row) => <span className="num">{formatTokens(row.input)}</span>,
      },
      {
        id: 'output',
        header: c.output,
        sortable: true,
        render: (row) => <span className="num">{formatTokens(row.output)}</span>,
      },
      {
        id: 'cost',
        header: c.cost,
        sortable: true,
        render: (row) => <span className="num">{formatCost(row.cost)}</span>,
      },
    ];
  }, [today, c]);

  const dayLabel = day ? formatDay(day, { weekday: true }) : '';
  const emptyText = !data
    ? NO_VALUE
    : filtered
      ? c.emptyFiltered
      : day
        ? c.emptyDay(dayLabel)
        : c.empty;

  return (
    <section
      className={
        loading ? 'card table-card sessions-table is-loading' : 'card table-card sessions-table'
      }
      aria-busy={loading}
    >
      <header className="table-card-header">
        <div>
          <h2 className="card-title">{day ? c.titleOfDay(dayLabel) : c.title}</h2>
          <p className="card-hint">{c.hint}</p>
        </div>
      </header>
      <DataTable
        label={c.label}
        columns={columns}
        rows={data?.rows ?? []}
        rowKey={rowKey}
        sort={{ column: sort.key, direction: sort.direction }}
        onSortChange={(next: SortState) =>
          onSort({ key: next.column as SessionSortKey, direction: next.direction })
        }
        onSelect={onSelect}
        selectedKey={selected}
        emptyText={emptyText}
      />
      {data && data.total > 0 && <Pager data={data} onPage={onPage} />}
    </section>
  );
}

function Pager({ data, onPage }: { data: SessionsData; onPage: (page: number) => void }) {
  const p = t.pager;
  const first = data.page * data.pageSize + 1;
  const last = Math.min(data.total, (data.page + 1) * data.pageSize);
  const lastPage = Math.max(0, Math.ceil(data.total / data.pageSize) - 1);
  return (
    <nav className="pager" aria-label={p.label}>
      <span className="pager-range num" aria-live="polite">
        {p.range(formatInt(first), formatInt(last), formatInt(data.total))}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label={p.previous}
        title={p.previous}
        disabled={data.page === 0}
        onClick={() => onPage(data.page - 1)}
      >
        <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={p.next}
        title={p.next}
        disabled={data.page >= lastPage}
        onClick={() => onPage(data.page + 1)}
      >
        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
      </button>
    </nav>
  );
}
