import { FolderSearch } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDays } from '../../shared/period';
import type { Calendar as CalendarData, Streak } from '../../shared/types';
import { CategoryBars, type CategoryItem } from '../components/CategoryBars';
import { EmptyState } from '../components/EmptyState';
import { Heatmap } from '../components/Heatmap';
import { HourBars } from '../components/HourBars';
import { KpiCard } from '../components/KpiCard';
import { Page } from '../components/Page';
import { useToday } from '../hooks/useToday';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { formatDay, formatMonth, formatPercent, formatTokens } from '../lib/format';
import { sessionsOfDay } from '../routes';
import { useAppData } from '../state/appData';
import { ALL_MACHINES, useFilters } from '../state/filters';

const NO_VALUE = '—';
const t = en.calendar;

export function Calendar() {
  const { machineId } = useFilters();
  // Not sent: the main process knows today. It only makes the page load again at midnight.
  const today = useToday();
  const { info } = useAppData();
  const fetchCalendar = useCallback(
    () => window.api.getCalendar(machineId === ALL_MACHINES ? undefined : [machineId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` is the reload trigger
    [machineId, today],
  );
  const { data } = useUsageQuery(fetchCalendar);
  const navigate = useNavigate();
  const openDay = useCallback((day: string) => void navigate(sessionsOfDay(day)), [navigate]);

  if (data && !data.hasData) {
    return (
      <Page section="calendar" periodIgnored={t.periodIgnored}>
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
    <Page section="calendar" periodIgnored={t.periodIgnored}>
      <KpiRow data={data} />
      <section className="card chart-card calendar-heatmap">
        <header className="chart-card-header">
          <h2 className="card-title">{t.heatmap.title}</h2>
          <span className="chart-card-hint">{t.heatmap.hint}</span>
        </header>
        {data ? (
          <Heatmap heatmap={data.heatmap} today={data.today} onOpenDay={openDay} />
        ) : (
          <div className="heatmap-placeholder" />
        )}
      </section>
      <div className="calendar-charts">
        <WeekdayCard data={data} />
        <section className="card chart-card calendar-chart">
          <header className="chart-card-header">
            <h2 className="card-title">{t.hour.title}</h2>
          </header>
          <div className="chart-card-body">
            <HourBars
              hours={data?.byHour ?? Array.from({ length: 24 }, () => 0)}
              label={t.hour.label}
              shareLabel={t.share}
            />
          </div>
        </section>
        <MonthCard data={data} />
      </div>
    </Page>
  );
}

function KpiRow({ data }: { data: CalendarData | null }) {
  const k = t.kpi;
  const kpis = data?.kpis;
  const today = data?.today ?? '';
  /** The year is written only when it is not this year's. */
  const day = (value: string) =>
    formatDay(value, { year: value.slice(0, 4) !== today.slice(0, 4) });

  return (
    <div className="kpi-grid kpi-grid--5">
      <KpiCard
        label={k.active}
        value={kpis ? `${kpis.activeDays} / ${kpis.totalDays}` : NO_VALUE}
        hint={kpis ? k.activeHint(formatPercent(kpis.activeDays / kpis.totalDays)) : NO_VALUE}
      />
      <KpiCard
        label={k.current}
        value={kpis ? t.days(kpis.currentStreak?.days ?? 0) : NO_VALUE}
        hint={kpis ? currentHint(kpis.currentStreak, today, day) : NO_VALUE}
      />
      <KpiCard
        label={k.longest}
        value={kpis ? t.days(kpis.longestStreak?.days ?? 0) : NO_VALUE}
        hint={kpis ? streakRange(kpis.longestStreak, day) : NO_VALUE}
      />
      <KpiCard
        label={k.best}
        value={kpis?.bestDay ? formatTokens(kpis.bestDay.tokens) : NO_VALUE}
        hint={
          kpis
            ? kpis.bestDay
              ? formatDay(kpis.bestDay.day, { weekday: true, year: true })
              : k.none
            : NO_VALUE
        }
      />
      <KpiCard
        label={k.average}
        value={
          kpis?.averagePerActiveDay != null ? formatTokens(kpis.averagePerActiveDay) : NO_VALUE
        }
        hint={kpis ? k.averageHint : NO_VALUE}
      />
    </div>
  );
}

function currentHint(streak: Streak | null, today: string, day: (value: string) => string) {
  if (!streak) return t.kpi.noCurrent;
  return streak.to === addDays(today, -1)
    ? t.kpi.currentUntilYesterday(day(streak.from))
    : t.kpi.currentSince(day(streak.from));
}

function streakRange(streak: Streak | null, day: (value: string) => string) {
  if (!streak) return t.kpi.none;
  return streak.days === 1
    ? day(streak.from)
    : t.kpi.longestRange(day(streak.from), day(streak.to));
}

function WeekdayCard({ data }: { data: CalendarData | null }) {
  const items: CategoryItem[] = useMemo(
    () =>
      en.dates.weekdays.map((label, index) => ({
        key: label,
        label,
        title: en.dates.weekdaysLong[index]!,
        value: data?.byWeekday[index] ?? 0,
        highlight: index === data?.bestWeekday,
      })),
    [data],
  );
  const best = data?.bestWeekday;

  return (
    <section className="card chart-card calendar-chart">
      <header className="chart-card-header">
        <h2 className="card-title">{t.weekday.title}</h2>
        {best != null && (
          <span className="chart-legend">
            <span className="chart-legend-item">
              <span className="swatch swatch--highlight" aria-hidden="true" />
              {t.weekday.busiest}{' '}
              <span className="chart-legend-value">{en.dates.weekdaysLong[best]}</span>
            </span>
          </span>
        )}
      </header>
      <div className="chart-card-body">
        <CategoryBars items={items} label={t.weekday.label} shareLabel={t.share} />
      </div>
    </section>
  );
}

function MonthCard({ data }: { data: CalendarData | null }) {
  const items: CategoryItem[] = useMemo(() => {
    const months = data?.byMonth ?? [];
    return months.map((point, index) => {
      const title = formatMonth(point.month, { year: true });
      return {
        key: point.month,
        label: formatMonth(point.month),
        title: index === months.length - 1 ? `${title} · ${t.month.soFar}` : title,
        value: point.tokens,
      };
    });
  }, [data]);

  return (
    <section className="card chart-card calendar-chart calendar-months">
      <header className="chart-card-header">
        <h2 className="card-title">{t.month.title}</h2>
      </header>
      <div className="chart-card-body">
        <CategoryBars items={items} label={t.month.label} shareLabel={t.share} />
      </div>
    </section>
  );
}
