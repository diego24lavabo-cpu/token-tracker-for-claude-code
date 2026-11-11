import { formatPercent, formatTokens } from '../lib/format';

export interface SplitPart {
  key: string;
  label: string;
  tokens: number;
  share: number;
}

/** Colors of the parts, in order. They differ in lightness, not only in hue. */
const PART_CLASSES = ['split-part--1', 'split-part--2', 'split-part--3', 'split-part--4'] as const;

function partClass(index: number): string {
  return PART_CLASSES[Math.min(index, PART_CLASSES.length - 1)]!;
}

/** One bar cut into parts, with a legend under it: for example the share of each machine. */
export function SplitBar({ parts, label }: { parts: SplitPart[]; label: string }) {
  return (
    <div className="split" role="group" aria-label={label}>
      <div className="split-bar" aria-hidden="true">
        {parts.map((part, index) => (
          <span
            key={part.key}
            className={`split-part ${partClass(index)}`}
            style={{ flexGrow: part.share }}
            title={`${part.label} · ${formatTokens(part.tokens)}`}
          />
        ))}
      </div>
      <ul className="split-legend">
        {parts.map((part, index) => (
          <li key={part.key} className="split-legend-item">
            <span className={`swatch ${partClass(index)}`} aria-hidden="true" />
            {part.label}
            <span className="num">{formatPercent(part.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
