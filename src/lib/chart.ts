/** Presentation helpers for charts: axis scales and tick placement. No usage numbers are computed here. */

/** Chart colors, mirroring the CSS variables of `theme.css` for use in SVG attributes. */
export const CHART_COLORS = {
  accent: '#d97757',
  accentLight: '#f2b59b',
  accentDark: '#8e4a33',
  accentPale: '#fae3d8',
  accentOutput: '#f2c4b0',
  heat1: '#5a3326',
  heat3: '#c2633f',
  axis: '#a3a094',
  grid: '#2a2925',
} as const;

/**
 * Colors of a chart with one series per item, such as one per model. The first four
 * differ in lightness; the two after them only serve when there are more items.
 */
const SERIES_COLORS = [
  CHART_COLORS.accent,
  CHART_COLORS.accentLight,
  CHART_COLORS.accentDark,
  CHART_COLORS.accentPale,
  CHART_COLORS.heat3,
  CHART_COLORS.heat1,
] as const;

/** The color of the series at `index`, starting again from the first after the last. */
export function seriesColor(index: number): string {
  return SERIES_COLORS[
    ((index % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length
  ]!;
}

/**
 * Colors of the machines, in the order of the Machines page cards: the design system
 * gives `--accent-dark` to the second machine.
 */
const MACHINE_COLORS = [
  CHART_COLORS.accent,
  CHART_COLORS.accentDark,
  CHART_COLORS.accentLight,
  CHART_COLORS.accentPale,
  CHART_COLORS.heat3,
  CHART_COLORS.heat1,
] as const;

export function machineColor(index: number): string {
  return MACHINE_COLORS[
    ((index % MACHINE_COLORS.length) + MACHINE_COLORS.length) % MACHINE_COLORS.length
  ]!;
}

/** Axis labels: small, muted, in the mono face like every number. */
export const AXIS_TICK = { fill: CHART_COLORS.axis, fontSize: 11, fontFamily: 'var(--font-mono)' };

/** The faint band behind the hovered bar. */
export const BAR_CURSOR = { fill: 'rgba(240, 238, 230, 0.05)' };

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest "round" number at or above `value`, for the top of an axis. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = NICE_STEPS.find((candidate) => candidate >= scaled - 1e-9) ?? 10;
  return step * magnitude;
}

/**
 * Picks which of `count` positions get an axis label: all of them when they fit, else
 * `wanted` evenly spaced ones that always include the first and the last.
 */
export function tickIndexes(count: number, wanted: number): number[] {
  if (count <= 0) return [];
  if (count <= wanted) return Array.from({ length: count }, (_, index) => index);
  const indexes = new Set<number>();
  for (let i = 0; i < wanted; i++) {
    indexes.add(Math.round((i * (count - 1)) / (wanted - 1)));
  }
  return [...indexes];
}
