import { formatPercent, formatTokens } from '../lib/format';

export interface HBarItem {
  key: string;
  label: string;
  /** Optional muted text after the label, for example a kind or a count. */
  detail?: string;
  tokens: number;
  /** 0 to 1: the bar length and the percentage shown. */
  share: number;
}

interface HBarsProps {
  items: HBarItem[];
  /** Accessible name of the list. */
  label: string;
}

/** Horizontal bars with a label and a percentage. Hovering a bar shows its tokens. */
export function HBars({ items, label }: HBarsProps) {
  return (
    <ul className="hbars" aria-label={label}>
      {items.map((item) => (
        <li
          key={item.key}
          className="hbar"
          title={`${item.label} · ${formatTokens(item.tokens)} · ${formatPercent(item.share)}`}
        >
          <span className="hbar-label">
            <span className="hbar-name">{item.label}</span>
            {item.detail && <span className="hbar-detail">{item.detail}</span>}
          </span>
          <span className="hbar-track" aria-hidden="true">
            <span
              className="hbar-fill"
              style={{ width: `${Math.max(0, Math.min(1, item.share)) * 100}%` }}
            />
          </span>
          <span className="hbar-value num">{formatPercent(item.share)}</span>
        </li>
      ))}
    </ul>
  );
}
