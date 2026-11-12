import { useEffect, useState, type ReactNode } from 'react';
import { AppDataContext, EMPTY_APP_DATA, type AppData } from './appData';

/**
 * Loads the app info, the machine list and the sync status, and reloads them when the
 * usage data or the sync status changes.
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(EMPTY_APP_DATA);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [info, machines, sync] = await Promise.all([
          window.api.getAppInfo(),
          window.api.getMachines(),
          window.api.getSyncStatus(),
        ]);
        if (!cancelled) setData({ info, machines, sync });
      } catch (error) {
        console.error('Failed to load app data', error);
      }
    };

    void load();
    const unsubscribeUsage = window.api.onUsageUpdated(() => void load());
    const unsubscribeSync = window.api.onSyncUpdated(() => void load());
    return () => {
      cancelled = true;
      unsubscribeUsage();
      unsubscribeSync();
    };
  }, []);

  return <AppDataContext.Provider value={data}>{children}</AppDataContext.Provider>;
}
