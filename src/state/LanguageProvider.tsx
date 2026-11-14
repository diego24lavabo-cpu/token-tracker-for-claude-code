import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { LanguageInfo, LanguageSetting } from '../../shared/language';
import { applyLanguage, LanguageContext } from './language';

/**
 * Holds the language. A change re-renders the components that read `useLanguage()`,
 * among them the app shell, so everything on screen renders again in the new language;
 * the pages not on screen mount in it. A `useMemo` that builds text must therefore list
 * `language` in its dependencies if it can stay on screen during a change (Settings,
 * title bar, sidebar).
 */
export function LanguageProvider({
  initial,
  children,
}: {
  initial: LanguageInfo;
  children: ReactNode;
}) {
  const [info, setInfo] = useState(initial);

  const change = useCallback(async (setting: LanguageSetting) => {
    const next = await window.api.setLanguage(setting);
    applyLanguage(next);
    setInfo(next);
  }, []);

  const value = useMemo(() => ({ info, change }), [info, change]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
