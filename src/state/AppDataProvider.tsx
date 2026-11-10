import { useEffect, useState, type ReactNode } from 'react';
import { AppDataContext, EMPTY_APP_DATA, type AppData } from './appData';

/** Loads the app info and the machine list, and reloads them when the usage data changes. */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(EMPTY_APP_DATA);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [info, machines] = await Promise.all([
          window.api.getAppInfo(),
          window.api.getMachines(),
        ]);
        if (!cancelled) setData({ info, machines });
      } catch (error) {
        console.error('Failed to load app data', error);
      }
    };

    void load();
    const unsubscribe = window.api.onUsageUpdated(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return <AppDataContext.Provider value={data}>{children}</AppDataContext.Provider>;
}
