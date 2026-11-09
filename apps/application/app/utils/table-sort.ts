import type { SortingState } from '@tanstack/vue-table';

/** A row's value to sort one column by. */
export type SortValue = number | string | null | undefined;

/**
 * Rows in the order a table's sorting state asks, for a table that shows them
 * a page at a time (`manualSorting`): sorted before they are paged, the sort
 * reads every row, not the page on screen, and every view of the page (the
 * table, its mobile cards) shows the same rows. `values` reads each sortable
 * column's value by column id; numbers compare as numbers, text as text, and a
 * row with no value sorts last. Rows equal on every sorted column keep their
 * order.
 */
export function sortRows<T>(
  rows: readonly T[],
  sorting: SortingState,
  values: Record<string, (row: T) => SortValue>,
): T[] {
  const keys = sorting.filter((key) => values[key.id]);
  if (keys.length === 0) return [...rows];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const key of keys) {
        const read = values[key.id]!;
        const va = read(a.row);
        const vb = read(b.row);
        const aMissing = va == null || va === '';
        const bMissing = vb == null || vb === '';
        if (aMissing || bMissing) {
          if (aMissing && bMissing) continue;
          return aMissing ? 1 : -1;
        }
        const order =
          typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb), 'en', { numeric: true });
        if (order !== 0) return key.desc ? -order : order;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}
