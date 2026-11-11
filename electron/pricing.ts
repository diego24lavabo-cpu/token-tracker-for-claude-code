/**
 * Cost estimate "at API prices".
 *
 * The prices live in an editable `pricing.json` in the user data folder. For people on a
 * subscription the result is only an equivalent: what the same usage would cost if it
 * were billed per token.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ModelPrices, Pricing, TokenBreakdown } from '../shared/types';

export const PRICING_FILE = 'pricing.json';

/** Cache writes cost 1.25 times the input price for the 5-minute cache and 2 times for the 1-hour cache. */
const CACHE_WRITE_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2;
/** Cache reads cost a tenth of the input price unless a model lists its own price. */
const CACHE_READ_RATE = 0.1;

/** Builds the prices of a model from its input and output prices and the standard cache rates. */
function prices(input: number, output: number, cacheRead = input * CACHE_READ_RATE): ModelPrices {
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    input,
    output,
    cacheWrite: round(input * CACHE_WRITE_RATE),
    cacheWrite1h: round(input * CACHE_WRITE_1H_RATE),
    cacheRead: round(cacheRead),
  };
}

/**
 * Default prices in US dollars per million tokens, from Anthropic's first-party API price
 * list as of 2026-11-03.
 *
 * TODO: Verify current prices at https://www.anthropic.com/pricing before release.
 *
 * Notes: Haiku 5.5 is priced for prompts up to 100K tokens (longer prompts cost more), and
 * its cache read price is the standard tenth of the input price, not a listed figure.
 */
export const DEFAULT_PRICING: Pricing = {
  lastChecked: '2026-11-03',
  models: {
    'Fable 5.2': prices(8, 40, 0.2),
    'Mythos 5.2': prices(8, 40, 0.2),
    'Fable 5.1': prices(10, 50, 0.25),
    'Mythos 5.1': prices(10, 50, 0.25),
    'Fable 5': prices(10, 50, 1),
    'Mythos 5': prices(10, 50, 1),
    'Opus 5.5': prices(4, 20, 0.2),
    'Opus 5': prices(5, 25),
    'Opus 4.8': prices(5, 25),
    'Opus 4.7': prices(5, 25),
    'Opus 4.6': prices(5, 25),
    'Sonnet 5.5': prices(2, 10, 0.1),
    'Sonnet 5': prices(2, 10),
    'Sonnet 4.6': prices(3, 15),
    'Haiku 5.5': prices(0.1, 0.5),
    'Haiku 4.5': prices(1, 5),
  },
};

/** Token counts of one model, with the 1-hour share of the cache writes. */
export type PricedTokens = TokenBreakdown & { cacheWrite1h: number };

const PER_MILLION = 1_000_000;

/** Cost in US dollars, or null when the model has no price. */
export function costOf(pricing: Pricing, model: string, tokens: PricedTokens): number | null {
  const price = Object.hasOwn(pricing.models, model) ? pricing.models[model] : undefined;
  if (!price) return null;
  const cacheWrite1h = Math.min(tokens.cacheWrite1h, tokens.cacheWrite);
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      (tokens.cacheWrite - cacheWrite1h) * price.cacheWrite +
      cacheWrite1h * price.cacheWrite1h +
      tokens.cacheRead * price.cacheRead) /
    PER_MILLION
  );
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Reads one model's prices from a file. Returns null unless every price is a valid number. */
function readModelPrices(value: unknown): ModelPrices | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const { input, output, cacheWrite, cacheWrite1h, cacheRead } = entry;
  if (!isPrice(input) || !isPrice(output) || !isPrice(cacheWrite) || !isPrice(cacheRead)) {
    return null;
  }
  return {
    input,
    output,
    cacheWrite,
    // Files written before the 1-hour price existed get the standard rate.
    cacheWrite1h: isPrice(cacheWrite1h) ? cacheWrite1h : input * CACHE_WRITE_1H_RATE,
    cacheRead,
  };
}

/**
 * Turns the content of a pricing file into a price table. Entries that cannot be read are
 * dropped, and default models missing from the file are added: a newer version of the app
 * can bring prices for new models without touching the ones the user edited.
 */
export function parsePricing(content: unknown): Pricing {
  const pricing: Pricing = { lastChecked: DEFAULT_PRICING.lastChecked, models: {} };

  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const file = content as Record<string, unknown>;
    if (typeof file.lastChecked === 'string' || file.lastChecked === null) {
      pricing.lastChecked = file.lastChecked;
    }
    if (typeof file.models === 'object' && file.models !== null && !Array.isArray(file.models)) {
      for (const [model, value] of Object.entries(file.models)) {
        const entry = readModelPrices(value);
        if (entry) pricing.models[model] = entry;
      }
    }
  }

  for (const [model, entry] of Object.entries(DEFAULT_PRICING.models)) {
    if (!Object.hasOwn(pricing.models, model)) pricing.models[model] = { ...entry };
  }
  return pricing;
}

/**
 * Loads `pricing.json` from the given folder. A missing or unreadable file gives the
 * defaults, and a missing file is created so it can be found and edited.
 */
export function loadPricing(folder: string): Pricing {
  const file = path.join(folder, PRICING_FILE);
  let content: unknown;
  let exists = true;
  try {
    content = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    exists = !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
  }

  const pricing = parsePricing(content);
  if (!exists) {
    try {
      savePricing(folder, pricing);
    } catch {
      // The estimate still works from memory when the folder cannot be written.
    }
  }
  return pricing;
}

/** Writes `pricing.json` through a temporary file, so a crash never leaves it half written. */
export function savePricing(folder: string, pricing: Pricing): void {
  const file = path.join(folder, PRICING_FILE);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(pricing, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
