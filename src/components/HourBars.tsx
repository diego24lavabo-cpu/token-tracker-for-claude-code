import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { en } from '../i18n/en';
import { AXIS_TICK, BAR_CURSOR, CHART_COLORS, niceCeil } from '../lib/chart';
import { formatPercent, formatTokens } from '../lib/format';
import { ChartTooltip, TooltipRow } from './ChartTooltip';

const LABELED_HOURS = [0, 6, 12, 18, 23];

interface HourPoint {
  hour: number;
  tokens: number;
  share: number;
}

interface HourBarsProps {
  /** 24 values, local hours 0 to 23. */
  hours: readonly number[];
  label: string;
  /** The tooltip row with each hour's share. Default: share of the day. */
  shareLabel?: string;
}

/** Tokens per hour of the day: 24 bars. */
export function HourBars({ hours, label, shareLabel = en.charts.ofTotal }: HourBarsProps) {
  const total = hours.reduce((sum, value) => sum + value, 0);
  const data: HourPoint[] = hours.map((tokens, hour) => ({
    hour,
    tokens,
    share: total > 0 ? tokens / total : 0,
  }));
  const top = niceCeil(Math.max(0, ...hours));

  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
          barCategoryGap="12%"
        >
          <XAxis
            dataKey="hour"
            ticks={LABELED_HOURS}
            tickFormatter={en.charts.hour}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval={0}
            tickMargin={8}
          />
          <YAxis domain={[0, top]} hide />
          <Tooltip
            content={<HourTooltip shareLabel={shareLabel} />}
            cursor={BAR_CURSOR}
            isAnimationActive={false}
          />
          <Bar
            dataKey="tokens"
            fill={CHART_COLORS.accent}
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface HourTooltipProps {
  shareLabel: string;
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: HourPoint }>;
}

function HourTooltip({ shareLabel, active, payload }: HourTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <ChartTooltip title={en.charts.hourRange(point.hour)}>
      <TooltipRow label={en.charts.tokens} value={formatTokens(point.tokens)} strong />
      <TooltipRow label={shareLabel} value={formatPercent(point.share)} />
    </ChartTooltip>
  );
}
