import { ArrowDown, ArrowUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { en } from '../i18n/en';
import { sortRows, type SortDirection, type SortValue } from '../lib/sort';

export interface Column<T> {
  id: string;
  header: string;
  /** What the column shows, as a tooltip on its header. */
  description?: string;
  /** Cell content. */
  render: (row: T) => ReactNode;
  /** The value the column sorts by. Without it, the column cannot be sorted. */
  sortValue?: (row: T) => SortValue;
  /** With `onSortChange`: the column can be sorted, by whoever owns the rows. */
  sortable?: boolean;
  /** Direction of the first click. Default: descending, largest first. */
  firstDirection?: SortDirection;
  /** Numbers are right-aligned. Default: `end`. */
  align?: 'start' | 'end';
  /** Extra class on the header and the cells of this column. */
  className?: string;
}

export interface SortState {
  column: string;
  direction: SortDirection;
}

interface DataTableProps<T> {
  /** Accessible name of the table. */
  label: string;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  initialSort?: SortState;
  /**
   * Controlled sorting: the rows come already sorted (by the main process, for a paged
   * table), `sort` says by what, and a header click calls `onSortChange`.
   */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** When set, rows can be selected: the first cell holds a button, and a click on the row selects it too. */
  onSelect?: (row: T) => void;
  selectedKey?: string | null;
  /** Shown in place of the rows when there are none. */
  emptyText: string;
  /** Content before the first cell's own content, outside its select button (a toggle). */
  rowPrefix?: (row: T) => ReactNode;
  /** Extra class on a row. */
  rowClassName?: (row: T) => string | undefined;
}

/** A table whose columns sort with a click on their header. */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  initialSort,
  sort: sortProp,
  onSortChange,
  onSelect,
  selectedKey,
  emptyText,
  rowPrefix,
  rowClassName,
}: DataTableProps<T>) {
  const [localSort, setLocalSort] = useState<SortState | null>(initialSort ?? null);
  const controlled = onSortChange !== undefined;
  const sort = controlled ? (sortProp ?? null) : localSort;

  const sorted = useMemo(() => {
    if (controlled) return rows;
    const column = sort && columns.find((candidate) => candidate.id === sort.column);
    if (!sort || !column?.sortValue) return rows;
    return sortRows(rows, column.sortValue, sort.direction);
  }, [rows, columns, sort, controlled]);

  const canSort = (column: Column<T>) =>
    column.sortValue !== undefined || (controlled && column.sortable === true);

  const toggle = (column: Column<T>) => {
    const next: SortState =
      sort?.column === column.id
        ? { column: column.id, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column: column.id, direction: column.firstDirection ?? 'desc' };
    if (onSortChange) onSortChange(next);
    else setLocalSort(next);
  };

  const alignClass = (column: Column<T>) =>
    [column.align === 'start' ? 'is-start' : 'is-end', column.className].filter(Boolean).join(' ');

  return (
    <div className="data-table-scroll">
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.column === column.id;
              const ariaSort = active
                ? sort.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : undefined;
              return (
                <th
                  key={column.id}
                  scope="col"
                  className={alignClass(column)}
                  aria-sort={ariaSort}
                  title={column.description}
                >
                  {canSort(column) ? (
                    <button
                      type="button"
                      className={active ? 'data-table-sort is-active' : 'data-table-sort'}
                      onClick={() => toggle(column)}
                      title={column.description ?? en.table.sortBy(column.header)}
                      aria-description={column.description}
                    >
                      {column.header}
                      {active &&
                        (sort.direction === 'asc' ? (
                          <ArrowUp size={12} strokeWidth={2} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={12} strokeWidth={2} aria-hidden="true" />
                        ))}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td className="data-table-empty" colSpan={columns.length}>
                {emptyText}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const key = rowKey(row);
              const selected = onSelect !== undefined && key === selectedKey;
              return (
                <tr
                  key={key}
                  className={[
                    onSelect && 'is-selectable',
                    selected && 'is-selected',
                    rowClassName?.(row),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={onSelect ? () => onSelect(row) : undefined}
                >
                  {columns.map((column, index) => {
                    const content =
                      index === 0 && onSelect ? (
                        <button
                          type="button"
                          className="data-table-select"
                          aria-pressed={selected}
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(row);
                          }}
                        >
                          {column.render(row)}
                        </button>
                      ) : (
                        column.render(row)
                      );
                    return (
                      <td key={column.id} className={alignClass(column)}>
                        {index === 0 && rowPrefix ? (
                          <div className="data-table-lead">
                            {rowPrefix(row)}
                            {content}
                          </div>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
