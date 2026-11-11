import { useMemo } from 'react';
import { periodRange } from '../../shared/period';
import type { Filters } from '../../shared/types';
import { ALL_MACHINES, useFilters } from '../state/filters';
import { useToday } from './useToday';

/** The machine and period selected in the header, as the filters the API expects. */
export function useRangeFilters(): Filters {
  const { machineId, period } = useFilters();
  const today = useToday();

  return useMemo(
    () => ({
      ...periodRange(period, today),
      machineIds: machineId === ALL_MACHINES ? undefined : [machineId],
    }),
    [machineId, period, today],
  );
}
