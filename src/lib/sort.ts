/** Sorting of table rows. Presentation only: the rows and their values come from the API. */

export type SortDirection = 'asc' | 'desc';

/** A value a column sorts by. `null` (no value) always goes last, whatever the direction. */
export type SortValue = number | string | null;

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

/**
 * Returns a sorted copy of `rows`. Text is compared the natural way (`app-2` before
 * `app-10`, case ignored), and rows with equal values keep their original order.
 */
export function sortRows<T>(
  rows: readonly T[],
  value: (row: T) => SortValue,
  direction: SortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        if (a.key === b.key) return a.index - b.index;
        return a.key === null ? 1 : -1;
      }
      const order =
        typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : collator.compare(String(a.key), String(b.key));
      return order === 0 ? a.index - b.index : sign * order;
    })
    .map((entry) => entry.row);
}
