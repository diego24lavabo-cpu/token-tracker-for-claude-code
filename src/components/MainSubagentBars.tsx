import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MainSubagentPoint } from '../../shared/types';
import { en } from '../i18n/en';
import { AXIS_TICK, BAR_CURSOR, CHART_COLORS, niceCeil, tickIndexes } from '../lib/chart';
import { formatDay, formatPercent, formatTokens, formatTokensAxis } from '../lib/format';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

const X_LABELS = 5;

interface MainSubagentBarsProps {
  data: MainSubagentPoint[];
  /** Today's local day, labeled as such on the axis. */
  today: string;
  /** Accessible description of the chart. */
  label: string;
}

/** One bar per day: main sessions at the bottom, their subagents stacked on top. */
export function MainSubagentBars({ data, today, label }: MainSubagentBarsProps) {
  const peak = data.reduce((max, point) => Math.max(max, point.main + point.subagent), 0);
  const top = niceCeil(peak);
  const labeledDays = tickIndexes(data.length, X_LABELS).flatMap((index) => data[index]?.day ?? []);
  const dayLabel = (day: string) => (day === today ? en.dates.today : formatDay(day));

  return (
    <div className="chart" role="img" aria-label={label}>
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
            dataKey="main"
            stackId="tokens"
            fill={CHART_COLORS.accent}
            maxBarSize={30}
            isAnimationActive={false}
          />
          <Bar
            dataKey="subagent"
            stackId="tokens"
            fill={CHART_COLORS.accentDark}
            maxBarSize={30}
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
  payload?: ReadonlyArray<{ payload?: MainSubagentPoint }>;
}

function DayTooltip({ active, payload }: DayTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const total = point.main + point.subagent;
  const t = en.charts;

  return (
    <ChartTooltip title={formatDay(point.day, { year: true })}>
      <TooltipRow label={t.total} value={formatTokens(total)} strong />
      <TooltipRow label={t.main} value={formatTokens(point.main)} swatch="main" />
      <TooltipRow label={t.subagents} value={formatTokens(point.subagent)} swatch="subagent" />
      <TooltipRow
        label={t.subagentShare}
        value={formatPercent(total > 0 ? point.subagent / total : 0)}
      />
    </ChartTooltip>
  );
}
