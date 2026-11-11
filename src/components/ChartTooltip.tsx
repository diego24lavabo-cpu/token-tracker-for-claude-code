import type { ReactNode } from 'react';

/** The swatch colors defined in theme.css. */
export type Swatch = 'input' | 'output' | 'main' | 'subagent';

/** The box a chart shows on hover: a title, then one row per value. */
export function ChartTooltip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-title">{title}</div>
      {children}
    </div>
  );
}

interface TooltipRowProps {
  label: string;
  value: string;
  swatch?: Swatch;
  strong?: boolean;
}

export function TooltipRow({ label, value, swatch, strong }: TooltipRowProps) {
  return (
    <div className={strong ? 'chart-tooltip-row chart-tooltip-row--strong' : 'chart-tooltip-row'}>
      <span className="chart-tooltip-label">
        {swatch && <span className={`swatch swatch--${swatch}`} aria-hidden="true" />}
        {label}
      </span>
      <span className="num">{value}</span>
    </div>
  );
}
