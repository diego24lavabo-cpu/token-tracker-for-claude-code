import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Heatmap as HeatmapData, HeatmapDay, HeatLevel } from '../../shared/types';
import { en } from '../i18n/en';
import { formatDay, formatInt, formatMonth, formatTokens } from '../lib/format';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

const t = en.calendar.heatmap;
const LEVELS: readonly HeatLevel[] = [0, 1, 2, 3, 4];
/** Rows that carry a weekday label: Monday, Wednesday, Friday, Sunday. */
const LABELED_WEEKDAYS = new Set([0, 2, 4, 6]);
/** The first column is labeled only when the next month label is at least this far. */
const FIRST_LABEL_ROOM = 3;
const TOOLTIP_GAP = 8;

interface HeatmapProps {
  heatmap: HeatmapData;
  /** Today's local day, marked on the grid. */
  today: string;
  /** Called with a day that has usage, when it is clicked or chosen with the keyboard. */
  onOpenDay: (day: string) => void;
}

interface Cell {
  day: HeatmapDay;
  column: number;
  row: number;
}

/** 53 weeks × 7 days, Monday on top. A custom CSS grid: one button per day. */
export function Heatmap({ heatmap, today, onOpenDay }: HeatmapProps) {
  const cells = useMemo(() => layOut(heatmap), [heatmap]);
  const months = useMemo(() => monthLabels(heatmap), [heatmap]);

  // Roving focus: the grid is one tab stop, the arrow keys move between days.
  const [focusIndex, setFocusIndex] = useState(cells.length - 1);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  /** True while a cell has keyboard focus. */
  const [focused, setFocused] = useState(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const wrapper = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);

  const current = Math.min(focusIndex, cells.length - 1);
  const shownIndex = hoverIndex ?? (focused ? current : null);
  const shown = shownIndex === null ? undefined : cells[shownIndex];

  // Places the tooltip above the cell, or below it when the card has no room above, and
  // keeps it inside the card horizontally.
  useLayoutEffect(() => {
    const box = tooltip.current;
    const frame = wrapper.current;
    const button = shownIndex === null ? null : buttons.current[shownIndex];
    if (!box || !frame || !button) return;
    const frameRect = frame.getBoundingClientRect();
    const cellRect = button.getBoundingClientRect();
    const cardTop = (frame.closest('.card') ?? frame).getBoundingClientRect().top;
    const width = box.offsetWidth;
    const height = box.offsetHeight;

    const center = cellRect.left + cellRect.width / 2 - frameRect.left;
    const left = Math.max(0, Math.min(frameRect.width - width, center - width / 2));
    const above = cellRect.top - height - TOOLTIP_GAP >= cardTop;
    const top = above
      ? cellRect.top - frameRect.top - height - TOOLTIP_GAP
      : cellRect.bottom - frameRect.top + TOOLTIP_GAP;
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, [shownIndex, shown]);

  const move = (index: number) => {
    const next = Math.max(0, Math.min(cells.length - 1, index));
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowUp: -1,
      ArrowDown: 1,
      ArrowLeft: -7,
      ArrowRight: 7,
    };
    if (event.key in steps) {
      move(current + steps[event.key]!);
    } else if (event.key === 'Home') {
      move(0);
    } else if (event.key === 'End') {
      move(cells.length - 1);
    } else {
      return;
    }
    event.preventDefault();
  };

  return (
    <div className="heatmap" ref={wrapper}>
      <div className="heatmap-months" aria-hidden="true">
        {months.map((month) => (
          <span
            key={month.column}
            className="heatmap-month"
            style={{ gridColumn: month.column + 1 }}
          >
            {month.label}
          </span>
        ))}
      </div>
      <div className="heatmap-weekdays" aria-hidden="true">
        {en.dates.weekdays.map((name, index) => (
          <span key={name}>{LABELED_WEEKDAYS.has(index) ? name : ''}</span>
        ))}
      </div>
      <div
        className="heatmap-grid"
        role="group"
        aria-label={t.label}
        onKeyDown={onKeyDown}
        // Keyboard focus shows the tooltip; a mouse click leaves that to the hover.
        onFocus={(event) => setFocused(event.target.matches(':focus-visible'))}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {cells.map((cell, index) => {
          const { day } = cell;
          const active = day.tokens > 0 || day.sessions > 0;
          const name = formatDay(day.day, { weekday: true, year: true });
          return (
            <button
              key={day.day}
              ref={(element) => {
                buttons.current[index] = element;
              }}
              type="button"
              className={`heatmap-cell heat-${day.level}${day.day === today ? ' is-today' : ''}`}
              style={{ gridColumn: cell.column + 1, gridRow: cell.row + 1 }}
              tabIndex={index === current ? 0 : -1}
              aria-label={
                active ? t.cell(name, formatTokens(day.tokens), day.sessions) : t.cellEmpty(name)
              }
              aria-disabled={!active}
              onMouseEnter={() => setHoverIndex(index)}
              onFocus={() => setFocusIndex(index)}
              onClick={() => {
                setFocusIndex(index);
                if (active) onOpenDay(day.day);
              }}
            />
          );
        })}
      </div>
      <Legend thresholds={heatmap.thresholds} />
      {shown && (
        <div className="heatmap-tooltip" ref={tooltip} aria-hidden="true">
          <DayTooltip day={shown.day} today={today} />
        </div>
      )}
    </div>
  );
}

function DayTooltip({ day, today }: { day: HeatmapDay; today: string }) {
  const name = formatDay(day.day, { weekday: true, year: true });
  const title = day.day === today ? `${t.today} · ${name}` : name;
  if (day.tokens === 0 && day.sessions === 0) {
    return (
      <ChartTooltip title={title}>
        <div className="chart-tooltip-row">{t.noUsage}</div>
      </ChartTooltip>
    );
  }
  return (
    <ChartTooltip title={title}>
      <TooltipRow label={t.tokens} value={formatTokens(day.tokens)} strong />
      <TooltipRow label={t.sessions} value={formatInt(day.sessions)} />
      <div className="chart-tooltip-hint">{t.open}</div>
    </ChartTooltip>
  );
}

/** "Less ■■■■■ More", each swatch telling the range of tokens it stands for. */
function Legend({ thresholds }: { thresholds: readonly number[] }) {
  return (
    <div className="heatmap-legend">
      <span>{t.less}</span>
      {LEVELS.map((level) => (
        <span
          key={level}
          className={`heatmap-swatch heat-${level}`}
          title={levelRange(level, thresholds)}
          aria-label={levelRange(level, thresholds)}
          role="img"
        />
      ))}
      <span>{t.more}</span>
    </div>
  );
}

function levelRange(level: HeatLevel, thresholds: readonly number[]): string {
  if (level === 0) return t.level[0];
  if (thresholds.length < 3) return t.level.empty;
  const lower = level === 1 ? 0 : thresholds[level - 2]!;
  const upper = level === 4 ? Infinity : thresholds[level - 1]!;
  if (upper <= lower) return t.level.empty;
  if (level === 1) return t.level[1](formatTokens(upper));
  if (level === 4) return t.level.top(formatTokens(lower));
  return t.level.range(formatTokens(lower), formatTokens(upper));
}

/** The days of the 12 months, oldest first, with their column (week) and row (weekday). */
function layOut(heatmap: HeatmapData): Cell[] {
  return heatmap.weeks.flatMap((week, column) =>
    week.days.flatMap((day, row) => (day ? [{ day, column, row }] : [])),
  );
}

/** A month name over the column holding its 1st, plus the first column when there is room. */
function monthLabels(heatmap: HeatmapData): { column: number; label: string }[] {
  const labels: { column: number; label: string }[] = [];
  heatmap.weeks.forEach((week, column) => {
    const first = week.days.find((day) => day?.day.endsWith('-01'));
    if (first) labels.push({ column, label: formatMonth(first.day.slice(0, 7)) });
  });
  const start = heatmap.weeks[0]?.days.find((day) => day !== null);
  if (start && !start.day.endsWith('-01') && (labels[0]?.column ?? Infinity) >= FIRST_LABEL_ROOM) {
    labels.unshift({ column: 0, label: formatMonth(start.day.slice(0, 7)) });
  }
  return labels;
}
