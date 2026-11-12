import { en } from '../i18n/en';
import { useAppData } from '../state/appData';
import { ALL_MACHINES, useFilters } from '../state/filters';
import { SegmentedControl } from './SegmentedControl';

/**
 * `All | <machine names>`. Applies to every section but the Machines page, which turns
 * it off with `disabledReason`.
 */
export function MachineSelector({ disabledReason }: { disabledReason?: string }) {
  const { machines } = useAppData();
  const { machineId, setMachineId } = useFilters();

  const options = [
    { value: ALL_MACHINES, label: en.header.allMachines },
    ...machines.map((machine) => ({ value: machine.id, label: machine.name })),
  ];
  // A machine that disappeared from the list falls back to "All".
  const selected = options.some((option) => option.value === machineId) ? machineId : ALL_MACHINES;

  return (
    <SegmentedControl
      label={en.header.machineSelector}
      options={options}
      value={disabledReason ? ALL_MACHINES : selected}
      onChange={setMachineId}
      tone="neutral"
      disabledReason={disabledReason}
    />
  );
}
