import type { TokenBreakdown } from '../../shared/types';
import { strings } from '../i18n';
import { formatPercent, formatTokens } from '../lib/format';

export interface TokenTypeItem {
  key: string;
  label: string;
  breakdown: TokenBreakdown;
}

/** The token types in the order of the bar, left to right. */
const TYPES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

interface TokenTypeBarsProps {
  items: TokenTypeItem[];
  /** Accessible name of the list. */
  label: string;
}

/** A share as text, never 0% for a type that has tokens. */
function shareText(tokens: number, share: number): string {
  return formatPercent(share, { nonZero: tokens > 0 });
}

/** One bar per item, cut by token type: input, output, cache read, cache write. */
export function TokenTypeBars({ items, label }: TokenTypeBarsProps) {
  const names = strings.models.tokenTypes.types;

  return (
    <div className="token-types">
      <ul className="token-type-list" aria-label={label}>
        {items.map((item) => {
          const total = TYPES.reduce((sum, type) => sum + item.breakdown[type], 0);
          const share = (type: (typeof TYPES)[number]) =>
            total > 0 ? item.breakdown[type] / total : 0;
          const tooltip = (type: (typeof TYPES)[number]) =>
            `${names[type]} · ${formatTokens(item.breakdown[type])} · ${formatPercent(share(type))}`;
          return (
            <li key={item.key} className="token-type-item">
              <span className="token-type-label">{item.label}</span>
              <span className="token-type-bar" aria-hidden="true">
                {TYPES.map((type) =>
                  item.breakdown[type] > 0 ? (
                    <span
                      key={type}
                      className={`token-type-part token-type--${type}`}
                      style={{ flexGrow: item.breakdown[type] }}
                      title={tooltip(type)}
                    />
                  ) : null,
                )}
              </span>
              <span className="token-type-values">
                {TYPES.map((type, index) => (
                  <span key={type} title={tooltip(type)}>
                    {index > 0 && ' · '}
                    {names[type]}{' '}
                    <span className="num">{shareText(item.breakdown[type], share(type))}</span>
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="chart-legend" aria-hidden="true">
        {TYPES.map((type) => (
          <span key={type} className="chart-legend-item">
            <span className={`swatch token-type--${type}`} />
            {names[type]}
          </span>
        ))}
      </div>
    </div>
  );
}
