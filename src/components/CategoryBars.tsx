import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS_TICK, BAR_CURSOR, CHART_COLORS, niceCeil } from '../lib/chart';
import { formatPercent, formatTokens } from '../lib/format';
import { en } from '../i18n/en';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

export interface CategoryItem {
  key: string;
  /** Under the bar. */
  label: string;
  /** At the top of the tooltip. */
  title: string;
  /** Tokens by default; a count in a histogram. */
  value: number;
  /** Drawn in `--accent-light`, such as the busiest weekday. */
  highlight?: boolean;
}

interface CategoryPoint extends CategoryItem {
  share: number;
}

interface CategoryBarsProps {
  items: readonly CategoryItem[];
  label: string;
  /** The tooltip row with each bar's share of the total. */
  shareLabel: string;
  /** The tooltip row with the value. Default: tokens. */
  valueLabel?: string;
  formatValue?: (value: number) => string;
}

/** One bar per category, all of them labeled: weekdays, months, histogram bins. */
export function CategoryBars({
  items,
  label,
  shareLabel,
  valueLabel = en.charts.tokens,
  formatValue = formatTokens,
}: CategoryBarsProps) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const data: CategoryPoint[] = items.map((item) => ({
    ...item,
    share: total > 0 ? item.value / total : 0,
  }));
  const top = niceCeil(Math.max(0, ...items.map((item) => item.value)));

  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
          barCategoryGap="14%"
        >
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval={0}
            tickMargin={8}
          />
          <YAxis domain={[0, top]} hide />
          <Tooltip
            content={
              <CategoryTooltip
                shareLabel={shareLabel}
                valueLabel={valueLabel}
                formatValue={formatValue}
              />
            }
            cursor={BAR_CURSOR}
            isAnimationActive={false}
          />
          <Bar dataKey="value" radius={[2, 2, 0, 0]} maxBarSize={64} isAnimationActive={false}>
            {data.map((point) => (
              <Cell
                key={point.key}
                fill={point.highlight ? CHART_COLORS.accentLight : CHART_COLORS.accent}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface CategoryTooltipProps {
  shareLabel: string;
  valueLabel: string;
  formatValue: (value: number) => string;
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: CategoryPoint }>;
}

function CategoryTooltip({
  shareLabel,
  valueLabel,
  formatValue,
  active,
  payload,
}: CategoryTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <ChartTooltip title={point.title}>
      <TooltipRow label={valueLabel} value={formatValue(point.value)} strong />
      <TooltipRow label={shareLabel} value={formatPercent(point.share)} />
    </ChartTooltip>
  );
}
