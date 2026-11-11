import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { WeeklyShare } from '../../shared/types';
import { en } from '../i18n/en';
import { AXIS_TICK, BAR_CURSOR, CHART_COLORS, niceCeil } from '../lib/chart';
import { formatDay, formatPercent, formatTokens, formatTokensAxis } from '../lib/format';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

export interface ModelSeries {
  name: string;
  color: string;
}

/** `tokens`: bar heights in tokens. `share`: every week with usage is a 100% bar. */
export type WeeklyMode = 'tokens' | 'share';

interface WeeklyModelBarsProps {
  data: WeeklyShare[];
  /** One entry per value of `WeeklyShare.tokens`, in the same order. */
  series: ModelSeries[];
  mode: WeeklyMode;
  /** Accessible description of the chart. */
  label: string;
}

function weekTotal(point: WeeklyShare): number {
  return point.tokens.reduce((sum, value) => sum + value, 0);
}

/** One bar per week, cut into one segment per model, the largest model at the bottom. */
export function WeeklyModelBars({ data, series, mode, label }: WeeklyModelBarsProps) {
  const share = mode === 'share';
  const top = share ? 1 : niceCeil(data.reduce((max, point) => Math.max(max, weekTotal(point)), 0));

  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          barCategoryGap="22%"
          stackOffset={share ? 'expand' : 'none'}
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
            tickFormatter={share ? (value: number) => formatPercent(value) : formatTokensAxis}
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
          {series.map((model, index) => (
            <Bar
              key={model.name}
              name={model.name}
              dataKey={(point: WeeklyShare) => point.tokens[index] ?? 0}
              stackId="tokens"
              fill={model.color}
              maxBarSize={44}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface WeekTooltipProps {
  series: ModelSeries[];
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: WeeklyShare }>;
}

function WeekTooltip({ series, active, payload }: WeekTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const total = weekTotal(point);

  return (
    <ChartTooltip title={en.models.weekly.weekOf(formatDay(point.week, { year: true }))}>
      <TooltipRow label={en.charts.total} value={formatTokens(total)} strong />
      {series.map((model, index) => {
        const tokens = point.tokens[index] ?? 0;
        if (tokens === 0) return null;
        return (
          <TooltipRow
            key={model.name}
            label={model.name}
            value={`${formatTokens(tokens)} · ${formatPercent(tokens / total)}`}
            color={model.color}
          />
        );
      })}
    </ChartTooltip>
  );
}
