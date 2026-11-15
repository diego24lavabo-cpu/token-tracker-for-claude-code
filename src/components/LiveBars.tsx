import { Bar, BarChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LiveHours, LiveMinute, LiveSeries } from '../../shared/types';
import { strings } from '../i18n';
import {
  AXIS_TICK,
  BAR_CURSOR,
  CHART_COLORS,
  niceCeil,
  rightMarginFor,
  seriesColor,
} from '../lib/chart';
import { formatClock, formatTokens, formatTokensAxis } from '../lib/format';
import { liveSeriesLabel } from '../lib/live';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

const MINUTE_MS = 60_000;
/** Minutes between two labels of the x axis, per chart range. */
const LABEL_EVERY: Readonly<Record<LiveHours, number>> = { 1: 10, 3: 30, 6: 60 };
/** A mark this close to the right edge (share of the chart) puts its label on its left. */
const NEAR_EDGE = 0.2;

interface LiveBarsProps {
  hours: LiveHours;
  series: LiveSeries[];
  minutes: LiveMinute[];
  /** Start of the running window, epoch milliseconds, or null when there is none. */
  windowStart: number | null;
  /** Accessible description of the chart. */
  label: string;
}

type Row = { t: number } & Record<string, number>;

/** One bar per minute, stacked by project. Marks show the start of the window and now. */
export function LiveBars({ hours, series, minutes, windowStart, label }: LiveBarsProps) {
  const rows: Row[] = minutes.map((minute) => {
    const row: Row = { t: minute.t };
    minute.tokens.forEach((value, index) => {
      row[`s${index}`] = value;
    });
    return row;
  });
  const peak = minutes.reduce(
    (max, minute) =>
      Math.max(
        max,
        minute.tokens.reduce((sum, value) => sum + value, 0),
      ),
    0,
  );
  const top = niceCeil(peak);

  const first = minutes[0]?.t;
  const last = minutes.at(-1)?.t;
  const every = LABEL_EVERY[hours];
  const ticks = minutes
    .filter((minute) => new Date(minute.t).getMinutes() % every === 0)
    .map((minute) => minute.t);
  // Room for the last label, centered on its minute, which can be the chart's last one.
  const lastTick = ticks.at(-1);
  const right = rightMarginFor(lastTick === undefined ? '' : formatClock(lastTick));

  // The minute holding the window's start, when it is inside the chart.
  const startMinute = windowStart !== null ? Math.floor(windowStart / MINUTE_MS) * MINUTE_MS : null;
  const showStart =
    startMinute !== null && first !== undefined && last !== undefined && startMinute >= first
      ? startMinute
      : null;
  const span = first !== undefined && last !== undefined ? Math.max(1, last - first) : 1;
  const startIsNear =
    showStart !== null && last !== undefined && (last - showStart) / span < NEAR_EDGE;

  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 20, right, bottom: 0, left: 0 }} barCategoryGap={0}>
          <XAxis
            dataKey="t"
            ticks={ticks}
            tickFormatter={formatClock}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval={0}
            tickMargin={8}
          />
          <YAxis
            domain={[0, top]}
            ticks={[0, top / 2, top]}
            tickFormatter={formatTokensAxis}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip
            content={<MinuteTooltip series={series} />}
            cursor={BAR_CURSOR}
            isAnimationActive={false}
          />
          {series.map((item, index) => (
            <Bar
              key={item.project ?? 'others'}
              dataKey={`s${index}`}
              stackId="tokens"
              fill={seriesColor(index)}
              maxBarSize={14}
              isAnimationActive={false}
            />
          ))}
          {showStart !== null && (
            <ReferenceLine
              x={showStart}
              stroke={CHART_COLORS.axis}
              strokeDasharray="3 3"
              label={
                <MarkLabel
                  text={strings.live.chart.windowStart}
                  color={CHART_COLORS.axis}
                  side={startIsNear ? 'left' : 'right'}
                />
              }
            />
          )}
          {last !== undefined && (
            <ReferenceLine
              x={last}
              stroke={CHART_COLORS.accentLight}
              label={
                // Both labels would meet when the window has just started.
                startIsNear ? undefined : (
                  <MarkLabel
                    text={strings.live.chart.now}
                    color={CHART_COLORS.accentLight}
                    side="left"
                  />
                )
              }
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface MarkLabelProps {
  text: string;
  color: string;
  /** Which side of the line the text sits on. */
  side: 'left' | 'right';
  /** Set by the reference line: its top end. */
  viewBox?: { x?: number; y?: number };
}

/** The label of a mark, in the margin above the plot so it never covers a bar. */
function MarkLabel({ text, color, side, viewBox }: MarkLabelProps) {
  if (viewBox?.x === undefined || viewBox.y === undefined) return null;
  const right = side === 'right';
  return (
    <text
      x={viewBox.x + (right ? 5 : -5)}
      y={viewBox.y - 6}
      textAnchor={right ? 'start' : 'end'}
      fill={color}
      fontSize={11}
    >
      {text}
    </text>
  );
}

interface MinuteTooltipProps {
  series: LiveSeries[];
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Row }>;
}

function MinuteTooltip({ series, active, payload }: MinuteTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  const values = series
    .map((item, index) => ({ item, index, value: row[`s${index}`] ?? 0 }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = values.reduce((sum, entry) => sum + entry.value, 0);
  // Nothing to say about a minute without a response.
  if (total === 0) return null;

  return (
    <ChartTooltip title={formatClock(row.t)}>
      <TooltipRow label={strings.live.chart.total} value={formatTokens(total)} strong />
      {values.map(({ item, index, value }) => (
        <TooltipRow
          key={item.project ?? 'others'}
          label={liveSeriesLabel(item)}
          value={formatTokens(value)}
          color={seriesColor(index)}
        />
      ))}
    </ChartTooltip>
  );
}
