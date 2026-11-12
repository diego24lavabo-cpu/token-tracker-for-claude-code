import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { WeeklyShare } from '../../shared/types';
import { en } from '../i18n/en';
import { AXIS_TICK, BAR_CURSOR, CHART_COLORS, niceCeil } from '../lib/chart';
import { formatDay, formatPercent, formatTokens, formatTokensAxis } from '../lib/format';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

export interface MachineSeries {
  name: string;
  color: string;
}

interface MachineWeeklyBarsProps {
  data: WeeklyShare[];
  /** One entry per value of `WeeklyShare.tokens`, in the same order. */
  series: MachineSeries[];
  label: string;
}

/** One group of bars per week, one bar per machine, side by side. */
export function MachineWeeklyBars({ data, series, label }: MachineWeeklyBarsProps) {
  const top = niceCeil(
    data.reduce((max, point) => Math.max(max, ...point.tokens.map((value) => value ?? 0)), 0),
  );

  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          barCategoryGap="18%"
          barGap={2}
        >
          <XAxis
            dataKey="week"
            tickFormatter={(week: string) => formatDay(week)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval="preserveStartEnd"
            minTickGap={10}
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
            content={<WeekTooltip series={series} />}
            cursor={BAR_CURSOR}
            isAnimationActive={false}
          />
          {series.map((machine, index) => (
            <Bar
              key={`${index}-${machine.name}`}
              name={machine.name}
              dataKey={(point: WeeklyShare) => point.tokens[index] ?? 0}
              fill={machine.color}
              maxBarSize={28}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface WeekTooltipProps {
  series: MachineSeries[];
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: WeeklyShare }>;
}

function WeekTooltip({ series, active, payload }: WeekTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const total = point.tokens.reduce((sum, value) => sum + value, 0);

  return (
    <ChartTooltip title={en.machines.weekly.weekOf(formatDay(point.week, { year: true }))}>
      <TooltipRow label={en.charts.total} value={formatTokens(total)} strong />
      {series.map((machine, index) => {
        const tokens = point.tokens[index] ?? 0;
        return (
          <TooltipRow
            key={`${index}-${machine.name}`}
            label={machine.name}
            value={total > 0 ? `${formatTokens(tokens)} · ${formatPercent(tokens / total)}` : '0'}
            color={machine.color}
          />
        );
      })}
    </ChartTooltip>
  );
}
