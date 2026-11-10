import { useMemo, useState, type ReactNode } from 'react';
import type { PeriodKey } from '../../shared/types';
import { ALL_MACHINES, DEFAULT_PERIOD, FiltersContext } from './filters';

/** Holds the machine and period selected in the page header. They apply to every section. */
export function FiltersProvider({ children }: { children: ReactNode }) {
  const [machineId, setMachineId] = useState<string>(ALL_MACHINES);
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_PERIOD);

  const value = useMemo(
    () => ({ machineId, period, setMachineId, setPeriod }),
    [machineId, period],
  );

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}
