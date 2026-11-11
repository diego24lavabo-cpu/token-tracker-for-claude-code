import type { TokenBreakdown } from '../../shared/types';
import { en } from '../i18n/en';
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

/** One bar per item, cut by token type: input, output, cache read, cache write. */
export function TokenTypeBars({ items, label }: TokenTypeBarsProps) {
  const names = en.models.tokenTypes.types;

  return (
    <div className="token-types">
      <ul className="token-type-list" aria-label={label}>
        {items.map((item) => {
          const total = TYPES.reduce((sum, type) => sum + item.breakdown[type], 0);
          const share = (type: (typeof TYPES)[number]) =>
            total > 0 ? item.breakdown[type] / total : 0;
          const summary = TYPES.map((type) => `${names[type]} ${formatPercent(share(type))}`).join(
            ', ',
          );
          return (
            <li key={item.key} className="token-type-item">
              <span className="token-type-label">{item.label}</span>
              <span className="visually-hidden">{summary}</span>
              <span className="token-type-bar" aria-hidden="true">
                {TYPES.map((type) =>
                  item.breakdown[type] > 0 ? (
                    <span
                      key={type}
                      className={`token-type-part token-type--${type}`}
                      style={{ flexGrow: item.breakdown[type] }}
                      title={`${names[type]} · ${formatTokens(item.breakdown[type])} · ${formatPercent(share(type))}`}
                    />
                  ) : null,
                )}
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
