import { FolderSearch } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import type { ModelCard as ModelCardData, Models as ModelsData } from '../../shared/types';
import { EmptyState } from '../components/EmptyState';
import { Page } from '../components/Page';
import { TokenTypeBars } from '../components/TokenTypeBars';
import { WeeklyModelBars, type ModelSeries } from '../components/WeeklyModelBars';
import { useRangeFilters } from '../hooks/useRangeFilters';
import { useUsageQuery } from '../hooks/useUsageQuery';
import { en } from '../i18n/en';
import { seriesColor } from '../lib/chart';
import { formatCost, formatInt, formatPercent, formatTokens } from '../lib/format';
import { useAppData } from '../state/appData';

const NO_VALUE = '—';
const t = en.models;

export function Models() {
  const filters = useRangeFilters();
  const { info } = useAppData();
  const fetchModels = useCallback(() => window.api.getModels(filters), [filters]);
  const { data } = useUsageQuery(fetchModels);
  const colors = useModelColors(data);

  if (data && !data.hasData) {
    return (
      <Page section="models">
        <EmptyState
          icon={<FolderSearch size={22} strokeWidth={1.75} />}
          title={en.overview.empty.title}
          body={en.overview.empty.body(
            info?.logRoots[0] ?? info?.defaultLogRoot ?? '~/.claude/projects',
          )}
        />
      </Page>
    );
  }

  const cards = data?.cards ?? [];

  return (
    <Page section="models">
      {data && cards.length === 0 ? (
        <div className="card models-empty">{t.cards.empty}</div>
      ) : (
        <div className="model-grid" role="list" aria-label={t.cards.label}>
          {cards.map((card) => (
            <ModelCard key={card.name} card={card} color={colors.get(card.name)!} />
          ))}
        </div>
      )}
      <div className="models-charts">
        <WeeklyCard data={data} colors={colors} />
        <TokenTypesCard cards={cards} />
      </div>
    </Page>
  );
}

/**
 * One color per model, the same on the cards and in the charts: the period's models in
 * card order, then the models seen only in the 12 weeks of the weekly chart.
 */
function useModelColors(data: ModelsData | null): Map<string, string> {
  return useMemo(() => {
    const names = [...(data?.cards ?? []).map((card) => card.name), ...(data?.weeklyModels ?? [])];
    const colors = new Map<string, string>();
    for (const name of names) {
      if (!colors.has(name)) colors.set(name, seriesColor(colors.size));
    }
    return colors;
  }, [data]);
}

function ModelCard({ card, color }: { card: ModelCardData; color: string }) {
  const c = t.cards;
  const inputShare = card.tokens > 0 ? card.input / card.tokens : 0;
  const outputShare = card.tokens > 0 ? card.output / card.tokens : 0;

  return (
    <article className="card model-card" role="listitem" aria-label={card.name}>
      <header className="model-card-header">
        <h2 className="model-card-name">
          <span
            className="swatch model-card-swatch"
            style={{ background: color }}
            aria-hidden="true"
          />
          <span className="model-card-title">{card.name}</span>
        </h2>
        <span className="model-card-share num">{formatPercent(card.share)}</span>
      </header>
      <div className="model-card-total num">{formatTokens(card.tokens)}</div>
      <div
        className="model-split"
        role="img"
        aria-label={c.split(formatPercent(inputShare), formatPercent(outputShare))}
        title={c.split(formatPercent(inputShare), formatPercent(outputShare))}
      >
        <span className="model-split-input" style={{ flexGrow: card.input }} />
        {card.output > 0 && (
          <span className="model-split-output" style={{ flexGrow: card.output }} />
        )}
      </div>
      <dl className="model-stats">
        <Stat label={c.input} value={formatTokens(card.input)} />
        <Stat label={c.output} value={formatTokens(card.output)} />
        <Stat
          label={c.cacheHitRate}
          hint={c.cacheHitRateHint}
          value={formatPercent(card.cacheHitRate)}
        />
        <Stat label={c.cost} value={formatCost(card.cost)} />
        <Stat label={c.messages} value={formatInt(card.messages)} />
        <Stat
          label={c.outputPerMessage}
          value={card.outputPerMessage === null ? NO_VALUE : formatTokens(card.outputPerMessage)}
        />
        <Stat
          label={c.subagents}
          hint={c.subagentsHint}
          value={formatPercent(card.subagentShare)}
          accent
        />
      </dl>
      <p className="model-card-footer">
        {c.topProject}{' '}
        <span className="model-card-project num" title={card.topProject}>
          {card.topProject || NO_VALUE}
        </span>
      </p>
    </article>
  );
}

interface StatProps {
  label: string;
  value: string;
  /** Shown on hover, to explain how the number is computed. */
  hint?: string;
  accent?: boolean;
}

function Stat({ label, value, hint, accent }: StatProps) {
  return (
    <div className="model-stat" title={hint}>
      <dt>{label}</dt>
      <dd className={accent ? 'num cell-accent' : 'num'}>{value}</dd>
    </div>
  );
}

function WeeklyCard({ data, colors }: { data: ModelsData | null; colors: Map<string, string> }) {
  const w = t.weekly;
  const series: ModelSeries[] = (data?.weeklyModels ?? []).map((name) => ({
    name,
    color: colors.get(name)!,
  }));
  const empty = data !== null && series.length === 0;

  return (
    <section className="card chart-card models-weekly">
      <header className="chart-card-header">
        <h2 className="card-title">{w.title}</h2>
        <div className="chart-legend">
          {series.map((model) => (
            <span key={model.name} className="chart-legend-item">
              <span className="swatch" style={{ background: model.color }} aria-hidden="true" />
              {model.name}
            </span>
          ))}
        </div>
      </header>
      <div className="chart-card-body">
        <WeeklyModelBars data={data?.weekly ?? []} series={series} label={w.label} />
        {empty && <p className="chart-empty">{w.empty}</p>}
      </div>
    </section>
  );
}

function TokenTypesCard({ cards }: { cards: ModelCardData[] }) {
  const tt = t.tokenTypes;
  return (
    <section className="card chart-card models-token-types">
      <header className="chart-card-header">
        <h2 className="card-title">{tt.title}</h2>
      </header>
      {cards.length === 0 ? (
        <p className="panel-empty">{t.cards.empty}</p>
      ) : (
        <TokenTypeBars
          label={tt.label}
          items={cards.map((card) => ({
            key: card.name,
            label: tt.item(card.name, formatPercent(card.cacheHitRate)),
            breakdown: card.breakdown,
          }))}
        />
      )}
    </section>
  );
}
