import { en } from '../i18n/en';
import { PERIODS, useFilters } from '../state/filters';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = PERIODS.map((period) => ({ value: period, label: en.header.periods[period] }));

/**
 * `7d | 30d | 90d | 1y`. Applies to every section but the Calendar, which turns it off
 * with `disabledReason`.
 */
export function PeriodSelector({ disabledReason }: { disabledReason?: string }) {
  const { period, setPeriod } = useFilters();

  return (
    <SegmentedControl
      label={en.header.periodSelector}
      options={OPTIONS}
      value={period}
      onChange={setPeriod}
      tone="accent"
      disabledReason={disabledReason}
    />
  );
}
