import { eq, sql } from 'drizzle-orm';
import { failureClusters } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { MAX_INT32 } from './storable-values';

/** The columns of the `(run, case, repeat, retries, browser)` unique index that a batch row carries. */
interface RunCaseKey {
  testCaseId: number;
  repeatEachIndex?: number | null;
  retries?: number | null;
  browserName?: string | null;
}

/**
 * A row's `repeat_each_index`: the `--repeat-each` repetition the reporter sent, 0 when it sent none (an older
 * reporter, a run without repeats) or a value that is not a non-negative integer its column holds.
 */
export function resolveRepeatEachIndex(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INT32 ? value : 0;
}

/**
 * Stable identity for a running test within a run, used to match a `begin` event to its later `complete`: its title,
 * location, browser and repetition, as the run page keys its row (`liveCaseKey`). A retry has the same key.
 */
export function runningCaseKey(tc: {
  title?: string;
  location?: string | null;
  browser?: unknown;
  repeatEachIndex?: unknown;
}): string {
  return `${tc.title}\x1f${tc.location ?? ''}\x1f${JSON.stringify(tc.browser ?? null)}\x1f${resolveRepeatEachIndex(tc.repeatEachIndex)}`;
}

function keyOf(row: RunCaseKey): string {
  return `${row.testCaseId}\x00${row.repeatEachIndex ?? 0}\x00${row.retries ?? 0}\x00${row.browserName ?? ''}`;
}

/**
 * Pair each row an `INSERT … ON CONFLICT DO NOTHING RETURNING` into
 * `test_runs_cases` gave back with the index of the batch row it came from. A
 * skipped row returns nothing, so the returned rows are matched on the unique
 * `(run, case, repeat, retries, browser)` key rather than by position: when the
 * batch repeats a key the first row is the one stored, and rows without a
 * browser never conflict, so rows sharing a key are matched in batch order.
 */
export function matchInsertedRunCases<T extends RunCaseKey>(
  rows: RunCaseKey[],
  inserted: T[],
): Array<T & { rowIndex: number }> {
  const indicesByKey = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = keyOf(row);
    const indices = indicesByKey.get(key);
    if (indices) indices.push(index);
    else indicesByKey.set(key, [index]);
  });

  return inserted.flatMap((row) => {
    const rowIndex = indicesByKey.get(keyOf(row))?.shift();
    return rowIndex === undefined ? [] : [{ ...row, rowIndex }];
  });
}

/**
 * Take back the failures a batch counted on its failure clusters for the rows the insert did not store: one it skipped
 * (a batch sent again, a row the batch repeats) or never wrote (the insert failed). A batch counts its failures on
 * their clusters before its rows are inserted, and only when its run's failures count as occurrences
 * (`countsOccurrences`, the `cluster-occurrences` use). Each counter moves down by what the batch added for those
 * rows, so the failures another batch counted meanwhile stay counted.
 */
export async function uncountClustersOfSkippedRows(
  db: DrizzleDB,
  rows: Array<{ failureClusterId?: number | null }>,
  inserted: Array<{ rowIndex: number }>,
  countsOccurrences: boolean,
): Promise<void> {
  if (!countsOccurrences) return;
  const stored = new Set(inserted.map((row) => row.rowIndex));
  const skipped = new Map<number, number>();
  rows.forEach((row, index) => {
    const clusterId = row.failureClusterId;
    if (clusterId != null && !stored.has(index)) skipped.set(clusterId, (skipped.get(clusterId) ?? 0) + 1);
  });
  for (const [clusterId, count] of skipped) {
    await db
      .update(failureClusters)
      .set({
        occurrences: sql`case when ${failureClusters.occurrences} > ${count} then ${failureClusters.occurrences} - ${count} else 0 end`,
      })
      .where(eq(failureClusters.id, clusterId));
  }
}
