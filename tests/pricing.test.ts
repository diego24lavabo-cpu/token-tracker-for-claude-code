import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  costOf,
  DEFAULT_PRICING,
  loadPricing,
  parsePricing,
  PRICING_FILE,
  savePricing,
} from '../electron/pricing';
import type { Pricing } from '../shared/types';
import { cleanupTempDirs, tempDir } from './helpers';

afterEach(cleanupTempDirs);

const MILLION = 1_000_000;
const none = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheWrite1h: 0 };

const pricing: Pricing = {
  lastChecked: '2026-11-03',
  models: {
    'Test 1': { input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  },
};

describe('costOf', () => {
  it('prices each token type per million tokens', () => {
    expect(costOf(pricing, 'Test 1', { ...none, input: MILLION })).toBe(4);
    expect(costOf(pricing, 'Test 1', { ...none, output: MILLION })).toBe(20);
    expect(costOf(pricing, 'Test 1', { ...none, cacheRead: MILLION })).toBeCloseTo(0.2, 10);
    expect(costOf(pricing, 'Test 1', none)).toBe(0);
  });

  it('prices 1-hour cache writes at their own rate', () => {
    const fiveMinutes = { ...none, cacheWrite: MILLION };
    expect(costOf(pricing, 'Test 1', fiveMinutes)).toBe(5);
    expect(costOf(pricing, 'Test 1', { ...fiveMinutes, cacheWrite1h: MILLION })).toBe(8);
    expect(costOf(pricing, 'Test 1', { ...fiveMinutes, cacheWrite1h: MILLION / 2 })).toBe(6.5);
    // The 1-hour share is part of the cache writes and cannot exceed them.
    expect(costOf(pricing, 'Test 1', { ...fiveMinutes, cacheWrite1h: 3 * MILLION })).toBe(8);
  });

  it('adds the token types up', () => {
    const cost = costOf(pricing, 'Test 1', {
      input: 2_000,
      output: 950_000,
      cacheWrite: 6_000_000,
      cacheRead: 320_000_000,
      cacheWrite1h: 6_000_000,
    });
    expect(cost).toBeCloseTo(0.008 + 19 + 48 + 64, 9);
  });

  it('returns null for a model without a price', () => {
    expect(costOf(pricing, 'Unknown 9', { ...none, input: MILLION })).toBeNull();
    expect(costOf(pricing, 'constructor', { ...none, input: MILLION })).toBeNull();
    expect(costOf(pricing, '__proto__', { ...none, input: MILLION })).toBeNull();
  });
});

describe('default prices', () => {
  it('follow the standard cache rates unless a model lists its own', () => {
    expect(DEFAULT_PRICING.models['Fable 5.2']).toEqual({
      input: 8,
      output: 40,
      cacheWrite: 10,
      cacheWrite1h: 16,
      cacheRead: 0.2,
    });
    expect(DEFAULT_PRICING.models['Opus 5.5']).toEqual({
      input: 4,
      output: 20,
      cacheWrite: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2,
    });
    expect(DEFAULT_PRICING.models['Opus 4.8']).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
    });
    expect(DEFAULT_PRICING.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('are complete and valid for every model', () => {
    for (const [model, prices] of Object.entries(DEFAULT_PRICING.models)) {
      for (const value of Object.values(prices)) {
        expect(Number.isFinite(value) && value >= 0, model).toBe(true);
      }
      expect(prices.output, model).toBeGreaterThan(prices.input);
      expect(prices.cacheRead, model).toBeLessThan(prices.input);
    }
  });
});

describe('parsePricing', () => {
  it('falls back to the defaults for anything unreadable', () => {
    for (const content of [undefined, null, 42, 'prices', [], {}]) {
      expect(parsePricing(content)).toEqual(DEFAULT_PRICING);
    }
  });

  it('keeps the prices the user edited and adds the default models that are missing', () => {
    const parsed = parsePricing({
      lastChecked: '2027-01-15',
      models: {
        'Opus 5.5': { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.15 },
        'Custom 1': { input: 1, output: 2, cacheWrite: 3, cacheWrite1h: 4, cacheRead: 0.5 },
      },
    });
    expect(parsed.lastChecked).toBe('2027-01-15');
    expect(parsed.models['Opus 5.5']?.input).toBe(3);
    expect(parsed.models['Custom 1']?.cacheWrite1h).toBe(4);
    expect(parsed.models['Fable 5.2']).toEqual(DEFAULT_PRICING.models['Fable 5.2']);
  });

  it('drops entries that are not complete, valid prices', () => {
    const parsed = parsePricing({
      models: {
        'Negative 1': { input: -1, output: 2, cacheWrite: 3, cacheRead: 0.5 },
        'Text 1': { input: '4', output: 20, cacheWrite: 5, cacheRead: 0.2 },
        'Partial 1': { input: 4, output: 20 },
        'Null 1': null,
      },
    });
    for (const model of ['Negative 1', 'Text 1', 'Partial 1', 'Null 1']) {
      expect(parsed.models[model]).toBeUndefined();
    }
  });

  it('gives a file without a 1-hour price the standard rate', () => {
    const parsed = parsePricing({
      models: { 'Old 1': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
    });
    expect(parsed.models['Old 1']?.cacheWrite1h).toBe(8);
  });

  it('accepts a cleared check date', () => {
    expect(parsePricing({ lastChecked: null, models: {} }).lastChecked).toBeNull();
  });
});

describe('loadPricing', () => {
  it('creates the file with the defaults when it is missing', () => {
    const folder = tempDir();
    expect(loadPricing(folder)).toEqual(DEFAULT_PRICING);
    const written: unknown = JSON.parse(fs.readFileSync(path.join(folder, PRICING_FILE), 'utf8'));
    expect(written).toEqual(DEFAULT_PRICING);
  });

  it('reads the prices the user saved', () => {
    const folder = tempDir();
    const edited = parsePricing({
      lastChecked: '2027-02-01',
      models: {
        'Opus 5.5': { input: 9, output: 9, cacheWrite: 9, cacheWrite1h: 9, cacheRead: 9 },
      },
    });
    savePricing(folder, edited);
    expect(loadPricing(folder)).toEqual(edited);
    expect(fs.existsSync(path.join(folder, `${PRICING_FILE}.tmp`))).toBe(false);
  });

  it('uses the defaults without overwriting a file it cannot read', () => {
    const folder = tempDir();
    const file = path.join(folder, PRICING_FILE);
    fs.writeFileSync(file, '{"models": {"Opus 5.5": {"input": 3,');
    expect(loadPricing(folder)).toEqual(DEFAULT_PRICING);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"models": {"Opus 5.5": {"input": 3,');
  });
});
