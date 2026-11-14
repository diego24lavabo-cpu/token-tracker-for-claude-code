/**
 * The UI strings in the current language.
 *
 * `strings` is a live view: reading `strings.settings.title`, or a part kept in a module
 * constant such as `const t = strings.settings`, always gives the current language's
 * text. The renderer and the main process each call `setLanguage`; the renderer then
 * renders again (see `LanguageProvider`). CSV headers do not come from here: they stay
 * English (`electron/csv.ts`).
 */
import type { Language } from '../../shared/language';
import { en } from './en';
import { fr } from './fr';

/** The shape of every language: `en` with its literal types widened to `string`. */
export type Strings = Widen<typeof en>;

type Widen<T> = T extends (...args: infer A) => unknown
  ? (...args: A) => string
  : T extends string
    ? string
    : { readonly [K in keyof T]: Widen<T[K]> };

export const STRINGS: Readonly<Record<Language, Strings>> = { en, fr };

/** The `Intl` locale of each language. */
export const LOCALES: Readonly<Record<Language, string>> = { en: 'en-US', fr: 'fr-FR' };

let current: Language = 'en';
const listeners = new Set<() => void>();

export function currentLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  for (const listener of listeners) listener();
}

/** Calls `listener` after each change of language. Returns the unsubscribe function. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const views = new Map<string, object>();

/** A view of the node at `path`: every read goes to the current language's node. */
function liveView<T extends object>(path: readonly PropertyKey[], shape: T): T {
  const id = path.map(String).join('\u0000');
  const cached = views.get(id);
  if (cached) return cached as T;
  const view = new Proxy(shape, {
    get(_shape, key) {
      let node: unknown = STRINGS[current];
      for (const step of path) node = (node as Record<PropertyKey, unknown>)[step];
      const value = (node as Record<PropertyKey, unknown>)[key];
      if (typeof value === 'object' && value !== null) {
        // The English node gives the shape: `Array.isArray` and `Object.keys` see it.
        const englishNode = (shape as Record<PropertyKey, unknown>)[key] as object;
        return liveView([...path, key], englishNode);
      }
      return value;
    },
  });
  views.set(id, view);
  return view;
}

export const strings: Strings = liveView([], en as Strings);
