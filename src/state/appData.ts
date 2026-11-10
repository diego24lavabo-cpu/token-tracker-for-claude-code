import { createContext, useContext } from 'react';
import type { AppInfo, Machine } from '../../shared/types';

export interface AppData {
  /** Null until the main process has answered. */
  info: AppInfo | null;
  machines: Machine[];
}

export const EMPTY_APP_DATA: AppData = { info: null, machines: [] };

export const AppDataContext = createContext<AppData>(EMPTY_APP_DATA);

export function useAppData(): AppData {
  return useContext(AppDataContext);
}
