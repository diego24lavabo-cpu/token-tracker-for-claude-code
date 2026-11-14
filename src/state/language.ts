import { createContext, useContext } from 'react';
import type { LanguageInfo, LanguageSetting } from '../../shared/language';
import { setLanguage } from '../i18n';

export interface LanguageContextValue {
  info: LanguageInfo;
  /** Stores the setting in the main process (menus, dialogs) and switches the page at once. */
  change(setting: LanguageSetting): Promise<void>;
}

export const LanguageContext = createContext<LanguageContextValue | null>(null);

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage needs a LanguageProvider');
  return value;
}

/** Applies a language to the strings, the number and date formats and `<html lang>`. */
export function applyLanguage(info: LanguageInfo): void {
  setLanguage(info.language);
  document.documentElement.lang = info.language;
}
