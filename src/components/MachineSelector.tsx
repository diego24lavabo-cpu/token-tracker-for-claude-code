import { en } from '../i18n/en';
import { useAppData } from '../state/appData';
import { ALL_MACHINES, useFilters } from '../state/filters';
import { SegmentedControl } from './SegmentedControl';

/** `All | <machine names>`. Applies to every section. */
export function MachineSelector() {
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
      value={selected}
      onChange={setMachineId}
      tone="neutral"
    />
  );
}
