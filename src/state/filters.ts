import { createContext, useContext } from 'react';
import type { PeriodKey } from '../../shared/types';

export const PERIODS: readonly PeriodKey[] = ['7d', '30d', '90d', '1y'];
export const DEFAULT_PERIOD: PeriodKey = '30d';
export const ALL_MACHINES = 'all';

export interface FiltersState {
  /** A machine id, or `ALL_MACHINES`. */
  machineId: string;
  period: PeriodKey;
  setMachineId: (machineId: string) => void;
  setPeriod: (period: PeriodKey) => void;
}

export const FiltersContext = createContext<FiltersState | null>(null);

export function useFilters(): FiltersState {
  const filters = useContext(FiltersContext);
  if (!filters) throw new Error('useFilters must be used inside <FiltersProvider>');
  return filters;
}
