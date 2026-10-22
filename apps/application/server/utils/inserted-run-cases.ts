/** The columns of the `(run, case, repeat, retries, browser)` unique index that a batch row carries. */
interface RunCaseKey {
  testCaseId: number;
  repeatEachIndex?: number | null;
  retries?: number | null;
  browserName?: string | null;
}

/**
 * A row's `repeat_each_index`: the `--repeat-each` repetition the reporter sent, 0 when it sent none (an older
 * reporter, a run without repeats) or a value that is not a non-negative integer.
 */
export function resolveRepeatEachIndex(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
