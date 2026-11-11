import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DailyPoint } from '../../shared/types';
import { en } from '../i18n/en';
import { AXIS_TICK, BAR_CURSOR, CHART_COLORS, niceCeil, tickIndexes } from '../lib/chart';
import { formatDay, formatPercent, formatTokens, formatTokensAxis } from '../lib/format';
import { ChartTooltip, TooltipRow } from './ChartTooltip';
const X_LABELS = 6;

interface StackedDailyBarsProps {
  data: DailyPoint[];
  /** Today's local day, labeled as such on the axis. */
  today: string;
}

/** One bar per day: input at the bottom, output stacked on top. */
export function StackedDailyBars({ data, today }: StackedDailyBarsProps) {
  const peak = data.reduce((max, point) => Math.max(max, point.input + point.output), 0);
  const top = niceCeil(peak);
  const labeledDays = tickIndexes(data.length, X_LABELS).flatMap((index) => data[index]?.day ?? []);
  const dayLabel = (day: string) => (day === today ? en.overview.daily.today : formatDay(day));

  return (
    <div className="chart" role="img" aria-label={en.overview.daily.chartLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 22, bottom: 0, left: 0 }}
          barCategoryGap="18%"
        >
          <XAxis
            dataKey="day"
            ticks={labeledDays}
            tickFormatter={dayLabel}
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
          <Tooltip content={<DayTooltip />} cursor={BAR_CURSOR} isAnimationActive={false} />
          <Bar
            dataKey="input"
            stackId="tokens"
            fill={CHART_COLORS.accent}
            maxBarSize={34}
            isAnimationActive={false}
          />
          <Bar
            dataKey="output"
            stackId="tokens"
            fill={CHART_COLORS.accentOutput}
            maxBarSize={34}
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface DayTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: DailyPoint }>;
}

function DayTooltip({ active, payload }: DayTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const total = point.input + point.output;

  return (
    <ChartTooltip title={formatDay(point.day, { year: true })}>
      <TooltipRow label={en.overview.daily.total} value={formatTokens(total)} strong />
      <TooltipRow
        label={en.overview.daily.input}
        value={formatTokens(point.input)}
        swatch="input"
      />
      <TooltipRow
        label={en.overview.daily.output}
        value={formatTokens(point.output)}
        swatch="output"
      />
      <TooltipRow
        label={en.overview.daily.subagents}
        value={total > 0 ? formatPercent(point.subagent / total) : formatPercent(0)}
      />
    </ChartTooltip>
  );
}
