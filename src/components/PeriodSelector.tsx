import { strings } from '../i18n';
import { PERIODS, useFilters } from '../state/filters';
import { SegmentedControl } from './SegmentedControl';

/**
 * `7d | 30d | 90d | 1y`. Applies to every section but the Calendar, which turns it off
 * with `disabledReason`.
 */
export function PeriodSelector({ disabledReason }: { disabledReason?: string }) {
  const { period, setPeriod } = useFilters();
  const options = PERIODS.map((value) => ({ value, label: strings.header.periods[value] }));

  return (
    <SegmentedControl
      label={strings.header.periodSelector}
      options={options}
      value={period}
      onChange={setPeriod}
      tone="accent"
      disabledReason={disabledReason}
    />
  );
}
