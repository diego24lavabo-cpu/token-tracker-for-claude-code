/**
 * The French strings against the English ones, the live `strings` view, and how the
 * language setting resolves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PREFERENCES_FILE, readPreferences, writePreferences } from '../electron/preferences';
import { resolveLanguage, systemLanguage } from '../shared/language';
import { en } from '../src/i18n/en';
import { fr } from '../src/i18n/fr';
import { currentLanguage, onLanguageChange, setLanguage, strings } from '../src/i18n';
import { cleanupTempDirs, tempDir } from './helpers';

afterEach(() => {
  setLanguage('en');
  cleanupTempDirs();
});

type Node = unknown;

/** Every key path of `reference` that `other` lacks, or holds with another kind of value. */
function differences(reference: Node, other: Node, at: string[] = []): string[] {
  const where = at.join('.') || '(root)';
  if (typeof reference === 'function') {
    if (typeof other !== 'function') return [`${where}: not a function`];
    const r = reference as (...args: unknown[]) => unknown;
    const o = other as (...args: unknown[]) => unknown;
    return r.length === o.length ? [] : [`${where}: ${o.length} parameters, not ${r.length}`];
  }
  if (typeof reference === 'string') {
    return typeof other === 'string' && other.trim() !== '' ? [] : [`${where}: missing or empty`];
  }
  if (Array.isArray(reference)) {
    if (!Array.isArray(other)) return [`${where}: not a list`];
    if (other.length !== reference.length) {
      return [`${where}: ${other.length} items, not ${reference.length}`];
    }
    return reference.flatMap((item, index) =>
      differences(item, other[index], [...at, String(index)]),
    );
  }
  if (typeof other !== 'object' || other === null) return [`${where}: missing`];
  const found: string[] = [];
  for (const [key, value] of Object.entries(reference as object)) {
    if (!Object.hasOwn(other, key)) found.push(`${[...at, key].join('.')}: missing`);
    else found.push(...differences(value, (other as Record<string, Node>)[key], [...at, key]));
  }
  for (const key of Object.keys(other)) {
    if (!Object.hasOwn(reference as object, key)) found.push(`${[...at, key].join('.')}: extra`);
  }
  return found;
}

/** Calls every function of a strings tree with sample arguments: `[path, result]`. */
function sampleTexts(node: Node, at: string[] = []): [string, string][] {
  if (typeof node === 'string') return [[at.join('.'), node]];
  if (typeof node === 'function') {
    const fn = node as (...args: unknown[]) => unknown;
    const args = Array.from({ length: fn.length }, (_, index) =>
      // `names` (Machines › versus) takes a list; booleans and nulls are covered by 'x'.
      at.at(-1) === 'versus' ? ['Mac', 'PC'] : index % 2 === 0 ? 3 : 'x',
    );
    return [[at.join('.'), String(fn(...args))]];
  }
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) => sampleTexts(value, [...at, key]));
  }
  return [];
}

describe('French strings', () => {
  it('have every key of the English ones, of the same kind', () => {
    expect(differences(en, fr)).toEqual([]);
  });

  it('notices a key missing from French', () => {
    const nav: Record<string, unknown> = { ...fr.nav };
    delete nav.agents;
    expect(differences(en, { ...fr, nav })).toEqual(['nav.agents: missing']);
  });

  it('give text for every function', () => {
    for (const [where, text] of sampleTexts(fr)) {
      expect(text.trim(), where).not.toBe('');
      expect(text, where).not.toContain('undefined');
    }
  });

  it('keep French typography: no plain space before : ; ? ! or inside « »', () => {
    for (const [where, text] of sampleTexts(fr)) {
      expect(text, where).not.toMatch(/ [:;?!»]|« /);
    }
  });

  it('keep tokens, cache, model names and Claude Code as they are', () => {
    expect(fr.overview.kpi.total).toContain('Tokens');
    expect(fr.models.cards.cacheHitRate).toContain('cache');
    expect(fr.pages.calendar.subtitle).toContain('Claude Code');
    expect(fr.app.name).toBe(en.app.name);
  });

  it('count 0 and 1 in the singular', () => {
    expect(fr.calendar.days(0)).toBe('0 jour');
    expect(fr.calendar.days(1)).toBe('1 jour');
    expect(fr.calendar.days(2)).toBe('2 jours');
    expect(en.calendar.days(0)).toBe('0 days');
  });
});

describe('strings', () => {
  it('follows the current language, also through a part kept aside', () => {
    const nav = strings.nav;
    const weekdays = strings.dates.weekdays;
    expect(nav.settings).toBe('Settings');
    setLanguage('fr');
    expect(currentLanguage()).toBe('fr');
    expect(nav.settings).toBe('Paramètres');
    expect(strings.dialogs.rebuild.confirm).toBe('Reconstruire');
    expect(weekdays.map((day) => day)).toEqual(fr.dates.weekdays);
    expect(Array.isArray(weekdays)).toBe(true);
    expect(strings.calendar.days(4)).toBe('4 jours');
  });

  it('tells listeners about a change, once', () => {
    let calls = 0;
    const stop = onLanguageChange(() => calls++);
    setLanguage('fr');
    setLanguage('fr');
    stop();
    setLanguage('en');
    expect(calls).toBe(1);
  });
});

describe('language setting', () => {
  it('uses the system language when the app has it, else English', () => {
    expect(systemLanguage(['fr-CH', 'en-US'])).toBe('fr');
    expect(systemLanguage(['fr'])).toBe('fr');
    expect(systemLanguage(['FR_fr'])).toBe('fr');
    expect(systemLanguage(['en-GB'])).toBe('en');
    // Only the first language counts.
    expect(systemLanguage(['de-DE', 'fr-FR'])).toBe('en');
    expect(systemLanguage([])).toBe('en');
  });

  it('resolves the setting', () => {
    expect(resolveLanguage('system', ['fr-FR'])).toEqual({
      setting: 'system',
      language: 'fr',
      system: 'fr',
    });
    expect(resolveLanguage('en', ['fr-FR'])).toEqual({
      setting: 'en',
      language: 'en',
      system: 'fr',
    });
    expect(resolveLanguage('fr', ['ja-JP']).language).toBe('fr');
  });

  it('is kept in preferences.json, which never breaks the app', () => {
    const folder = tempDir();
    expect(readPreferences(folder)).toEqual({ language: 'system' });
    writePreferences(folder, { language: 'fr' });
    expect(readPreferences(folder)).toEqual({ language: 'fr' });
    expect(fs.readdirSync(folder)).toEqual([PREFERENCES_FILE]);

    const file = path.join(folder, PREFERENCES_FILE);
    fs.writeFileSync(file, '{"language":"de"}');
    expect(readPreferences(folder)).toEqual({ language: 'system' });
    fs.writeFileSync(file, 'not json');
    expect(readPreferences(folder)).toEqual({ language: 'system' });
  });
});
