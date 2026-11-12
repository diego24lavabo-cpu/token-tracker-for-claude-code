import { useMemo, useState } from 'react';
import type { ModelPrices, Pricing } from '../../shared/types';
import { en } from '../i18n/en';
import { isDay } from '../../shared/period';
import { useToday } from '../hooks/useToday';
import { formatTokens } from '../lib/format';

const t = en.settings.pricing;

type Field = keyof ModelPrices;
const FIELDS: readonly Field[] = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'];
/** Same limit as the main process, which checks again. */
const MAX_PRICE = 10_000;

type DraftRow = Record<Field, string>;
const EMPTY_ROW: DraftRow = {
  input: '',
  output: '',
  cacheWrite: '',
  cacheWrite1h: '',
  cacheRead: '',
};

interface PricingEditorProps {
  current: Pricing;
  defaults: Pricing;
  usedModels: readonly { name: string; tokens: number }[];
  showAll: boolean;
  disabled: boolean;
  saving: boolean;
  onSave: (pricing: Pricing) => void;
  onToggleShowAll: () => void;
}

function rowOf(prices: ModelPrices | undefined): DraftRow {
  if (!prices) return { ...EMPTY_ROW };
  const row = { ...EMPTY_ROW };
  for (const field of FIELDS) row[field] = String(prices[field]);
  return row;
}

/** A price typed by the user, or null when the text is not a valid price. Empty is `''`. */
function parsePrice(text: string): number | '' | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return '';
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value <= MAX_PRICE ? value : null;
}

/**
 * The price table. Each row is either complete or, for a model the app has no default
 * price for, empty (no price). Saving sends the whole table to the main process.
 * The parent remounts it (with a `key`) when the saved prices change.
 */
export function PricingEditor({
  current,
  defaults,
  usedModels,
  showAll,
  disabled,
  saving,
  onSave,
  onToggleShowAll,
}: PricingEditorProps) {
  const models = useMemo(() => {
    const used = usedModels.map((model) => model.name);
    const others = Object.keys(current.models).filter((name) => !used.includes(name));
    return { used, all: [...used, ...others] };
  }, [current, usedModels]);
  const tokensOf = useMemo(
    () => new Map(usedModels.map((model) => [model.name, model.tokens])),
    [usedModels],
  );

  const [rows, setRows] = useState<Record<string, DraftRow>>(() =>
    Object.fromEntries(models.all.map((name) => [name, rowOf(current.models[name])])),
  );
  const [lastChecked, setLastChecked] = useState(current.lastChecked ?? '');
  const today = useToday();
  // A plain field rather than a date picker, which would follow the system's language.
  const dateInvalid = lastChecked !== '' && !isDay(lastChecked);

  // Validate every row and build the table to save.
  const { pricing, invalid } = useMemo(() => {
    const invalidCells = new Set<string>();
    const result: Pricing = { lastChecked: lastChecked || null, models: {} };
    for (const name of models.all) {
      const row = rows[name] ?? EMPTY_ROW;
      const values = FIELDS.map((field) => parsePrice(row[field]));
      const empty = values.every((value) => value === '');
      if (empty && !Object.hasOwn(defaults.models, name)) continue;
      const prices = {} as ModelPrices;
      FIELDS.forEach((field, index) => {
        const value = values[index];
        if (typeof value === 'number') prices[field] = value;
        else invalidCells.add(`${name}\u0000${field}`);
      });
      if (FIELDS.every((field) => !invalidCells.has(`${name}\u0000${field}`))) {
        result.models[name] = prices;
      }
    }
    return { pricing: result, invalid: invalidCells };
  }, [rows, lastChecked, models, defaults]);

  const dirty = useMemo(() => {
    if (pricing.lastChecked !== current.lastChecked) return true;
    const savedNames = Object.keys(current.models).filter((name) => models.all.includes(name));
    const draftNames = Object.keys(pricing.models);
    if (savedNames.length !== draftNames.length) return true;
    return draftNames.some((name) => {
      const saved = current.models[name];
      const draft = pricing.models[name];
      return !saved || !draft || FIELDS.some((field) => saved[field] !== draft[field]);
    });
  }, [pricing, current, models]);

  const visible = showAll || models.used.length === 0 ? models.all : models.used;
  const hidden = models.all.length - visible.length;

  const setCell = (name: string, field: Field, text: string) =>
    setRows((previous) => ({
      ...previous,
      [name]: { ...(previous[name] ?? EMPTY_ROW), [field]: text },
    }));

  const reset = () => {
    setRows(Object.fromEntries(models.all.map((name) => [name, rowOf(defaults.models[name])])));
    setLastChecked(defaults.lastChecked ?? '');
  };

  const header: Record<Field, string> = {
    input: t.input,
    output: t.output,
    cacheWrite: t.cacheWrite,
    cacheWrite1h: t.cacheWrite1h,
    cacheRead: t.cacheRead,
  };

  return (
    <form
      className="pricing-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid.size === 0 && !dateInvalid && dirty) onSave(pricing);
      }}
    >
      <div className="data-table-scroll">
        <table className="data-table pricing-table">
          <thead>
            <tr>
              <th scope="col">{t.model}</th>
              {FIELDS.map((field) => (
                <th key={field} scope="col" className="num-col">
                  {header[field]}
                </th>
              ))}
              <th scope="col" className="num-col">
                {t.usage}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((name) => {
              const row = rows[name] ?? EMPTY_ROW;
              const tokens = tokensOf.get(name);
              const unpriced = FIELDS.every((field) => row[field].trim() === '');
              return (
                <tr key={name}>
                  <th scope="row">
                    <span className="cell-name">{name}</span>
                  </th>
                  {FIELDS.map((field) => {
                    const bad = invalid.has(`${name}\u0000${field}`);
                    return (
                      <td key={field} className="num-col">
                        <input
                          className="price-input num"
                          inputMode="decimal"
                          value={row[field]}
                          placeholder="—"
                          disabled={disabled}
                          aria-invalid={bad || undefined}
                          aria-label={t.priceLabel(name, header[field])}
                          onChange={(event) => setCell(name, field, event.target.value)}
                        />
                      </td>
                    );
                  })}
                  <td className="num-col">
                    {tokens !== undefined ? (
                      <span className={`num${unpriced ? ' cell-accent' : ''}`}>
                        {formatTokens(tokens)}
                        {unpriced ? ` · ${t.noPrice}` : ''}
                      </span>
                    ) : (
                      <span className="cell-muted">{t.unused}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pricing-footer">
        <label className="pricing-date">
          {t.lastChecked}
          <input
            className="date-input num"
            value={lastChecked}
            placeholder="YYYY-MM-DD"
            maxLength={10}
            spellCheck={false}
            disabled={disabled}
            aria-invalid={dateInvalid || undefined}
            onChange={(event) => setLastChecked(event.target.value.trim())}
          />
        </label>
        <button
          type="button"
          className="button button--small"
          disabled={disabled || lastChecked === today}
          onClick={() => setLastChecked(today)}
        >
          {t.checkedToday}
        </button>
        {models.used.length > 0 && (hidden > 0 || showAll) && (
          <button type="button" className="filter-clear" onClick={onToggleShowAll}>
            {showAll ? t.showUsed : t.showAll(models.all.length)}
          </button>
        )}
        <span className="pricing-footer-spacer" />
        {(invalid.size > 0 || dateInvalid) && (
          <span className="settings-error" role="alert">
            {invalid.size > 0 ? t.invalid : t.invalidDate}
          </span>
        )}
        <button type="button" className="button" disabled={disabled || saving} onClick={reset}>
          {t.reset}
        </button>
        <button
          type="submit"
          className="button button--primary"
          disabled={disabled || saving || !dirty || invalid.size > 0 || dateInvalid}
        >
          {t.save}
        </button>
      </div>
    </form>
  );
}
