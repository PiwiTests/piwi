import { and, asc, eq, gt, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { hideSecretShapes, SECRET_SHAPE_STARTS } from '@piwitests/core/mask';
import { failureClusterAliases, failureClusters, testRuns, testRunsCases } from '../database/schema';
import { escapeLikePattern } from '#shared/utils/tag-filter';
import type { DrizzleDB } from '#shared/handlers/db';
import { getAppSetting, setAppSetting } from './app-settings';
import { whileNoShardEnds } from './shard-spans';

/** The app setting that records that {@link hideSecretShapesInClusterSamples} ran on this instance. */
export const CLUSTER_SAMPLE_SECRETS_SETTING = 'failure_cluster_sample_secrets_hidden_at';

/**
 * The app setting that records how far {@link hideSecretShapesInStoredErrors} got on this instance:
 * `{ column, after: <id> }` while it runs (`column` indexes {@link STORED_ERROR_COLUMNS}), `{ doneAt: <ISO date> }`
 * once it went through every column.
 */
export const STORED_ERROR_SECRETS_SETTING = 'stored_error_secrets_hidden';

type StoredErrorProgress = { column: number; after: number } | { doneAt: string };

/** How many rows that may hold a credential's shape one page of either pass reads. */
const SECRET_SHAPES_PAGE = 500;

/**
 * Whether a column's text may hold a credential's shape: it holds what one starts with (`SECRET_SHAPE_STARTS`), in
 * any case where the shape reads it so. A superset: SQLite's `LIKE` ignores ASCII case.
 */
function mayHoldSecretShape(column: SQLWrapper): SQL {
  const text = sql`CAST(${column} AS TEXT)`;
  return or(
    ...SECRET_SHAPE_STARTS.map(({ start, anyCase }) =>
      anyCase
        ? sql`LOWER(${text}) LIKE ${`%${escapeLikePattern(start.toLowerCase())}%`} ESCAPE '\\'`
        : sql`${text} LIKE ${`%${escapeLikePattern(start)}%`} ESCAPE '\\'`,
    ),
  )!;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hiddenText(value: unknown): unknown {
  return typeof value === 'string' ? hideSecretShapes(value) : value;
}

/** Each step's error message hidden. */
function hiddenStepErrors(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) =>
    isObject(step) && isObject(step.error) && typeof step.error.message === 'string'
      ? { ...step, error: { ...step.error, message: hideSecretShapes(step.error.message) } }
      : step,
  );
}

/** Each hook or fixture event's error line hidden. */
function hiddenEventErrors(events: unknown): unknown {
  if (!Array.isArray(events)) return events;
  return events.map((event) =>
    isObject(event) && typeof event.error === 'string' ? { ...event, error: hideSecretShapes(event.error) } : event,
  );
}

/** Each run error's message and stack hidden. */
function hiddenRunErrors(errors: unknown): unknown {
  if (!Array.isArray(errors)) return errors;
  return errors.map((error) =>
    isObject(error) ? { ...error, message: hiddenText(error.message), stack: hiddenText(error.stack) } : error,
  );
}

/**
 * The columns that keep a copy of a test's error text, or of an error outside any test, besides the failure clusters'
 * samples: the field each is written to, and how each value's shapes are hidden. A list of steps or events is read
 * only when one of them has an error (`errorField`), and a run's errors are rewritten while no shard adds its own.
 */
const STORED_ERROR_COLUMNS = [
  { table: testRunsCases, id: testRunsCases.id, column: testRunsCases.error, field: 'error', hide: hiddenText },
  {
    table: testRunsCases,
    id: testRunsCases.id,
    column: testRunsCases.steps,
    field: 'steps',
    hide: hiddenStepErrors,
    errorField: true,
  },
  {
    table: testRunsCases,
    id: testRunsCases.id,
    column: testRunsCases.stepEvents,
    field: 'stepEvents',
    hide: hiddenEventErrors,
    errorField: true,
  },
  {
    table: testRuns,
    id: testRuns.id,
    column: testRuns.runErrors,
    field: 'runErrors',
    hide: hiddenRunErrors,
    lock: whileNoShardEnds,
  },
] as const;

type StoredErrorColumn = (typeof STORED_ERROR_COLUMNS)[number];

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** Hide the shapes in one row's column, read again; whether it changed. */
async function hideInRow(db: DrizzleDB, c: StoredErrorColumn, id: number): Promise<boolean> {
  const [row] = await db.select({ value: c.column }).from(c.table).where(eq(c.id, id));
  if (!row) return false;
  const hidden = c.hide(row.value);
  if (!changed(row.value, hidden)) return false;
  await db
    .update(c.table)
    .set({ [c.field]: hidden } as never)
    .where(eq(c.id, id));
  return true;
}

/**
 * Hide each credential's shape (`hideSecretShapes`: a JWT, `Bearer …`, a service's key, a key or a token Piwi issues)
 * in the test errors stored before ingest hid them: the executions' errors, their steps' and their hooks' errors, and
 * the runs' errors outside any test. Reads only the rows whose column may hold one ({@link mayHoldSecretShape}), in
 * pages of {@link SECRET_SHAPES_PAGE} from `from` (a column of {@link STORED_ERROR_COLUMNS} and a row id), and calls
 * `onPage` with where each page ended. Returns how many rows it changed.
 */
export async function hideSecretShapesInStoredErrors(
  db: DrizzleDB,
  options: {
    from?: { column: number; after: number };
    onPage?: (at: { column: number; after: number }) => Promise<void>;
  } = {},
): Promise<number> {
  let hidden = 0;
  for (let column = options.from?.column ?? 0; column < STORED_ERROR_COLUMNS.length; column++) {
    const c = STORED_ERROR_COLUMNS[column]!;
    let after = column === options.from?.column ? options.from.after : 0;
    for (;;) {
      const page: Array<{ id: number; value: unknown }> = await db
        .select({ id: c.id, value: c.column })
        .from(c.table)
        .where(
          and(
            gt(c.id, after),
            'errorField' in c ? sql`CAST(${c.column} AS TEXT) LIKE ${'%"error"%'}` : undefined,
            mayHoldSecretShape(c.column),
          ),
        )
        .orderBy(asc(c.id))
        .limit(SECRET_SHAPES_PAGE);
      if (page.length === 0) break;
      for (const row of page) {
        if (!changed(row.value, c.hide(row.value))) continue;
        const rewrite = () => hideInRow(db, c, row.id);
        if (await ('lock' in c ? c.lock(row.id, rewrite) : rewrite())) hidden++;
      }
      after = page.at(-1)!.id;
      await options.onPage?.({ column, after });
    }
  }
  return hidden;
}

/**
 * Run {@link hideSecretShapesInStoredErrors} once per instance, from where an earlier start left it
 * ({@link STORED_ERROR_SECRETS_SETTING}), recording its progress after each page and the date once it is done.
 */
export async function hideSecretShapesInStoredErrorsOnce(db: DrizzleDB): Promise<number | null> {
  const progress = await getAppSetting<StoredErrorProgress>(db, STORED_ERROR_SECRETS_SETTING);
  if (progress && 'doneAt' in progress) return null;
  const hidden = await hideSecretShapesInStoredErrors(db, {
    from: progress ?? undefined,
    onPage: (at) => setAppSetting(db, STORED_ERROR_SECRETS_SETTING, at satisfies StoredErrorProgress),
  });
  await setAppSetting(db, STORED_ERROR_SECRETS_SETTING, {
    doneAt: new Date().toISOString(),
  } satisfies StoredErrorProgress);
  return hidden;
}

/**
 * Hide each credential's shape in the samples the failure clusters and their merge aliases keep (`sample_error`,
 * `fingerprint_sample`), stored before ingest hid them, reading only the rows that may hold one. Startup runs it once
 * per instance, after `backfillAliasSamples` (which matches samples as they were stored) and before
 * `reclusterFailureFingerprints`, which waits for both: a sample that changed is fingerprinted again there, as ingest
 * fingerprints the same failure, so a failure that recurs joins its cluster. Returns how many rows it changed.
 */
export async function hideSecretShapesInClusterSamples(db: DrizzleDB): Promise<number> {
  let hidden = 0;
  for (let after = 0; ;) {
    const page = await db
      .select({
        id: failureClusters.id,
        sampleError: failureClusters.sampleError,
        fingerprintSample: failureClusters.fingerprintSample,
      })
      .from(failureClusters)
      .where(
        and(
          gt(failureClusters.id, after),
          or(mayHoldSecretShape(failureClusters.sampleError), mayHoldSecretShape(failureClusters.fingerprintSample)),
        ),
      )
      .orderBy(asc(failureClusters.id))
      .limit(SECRET_SHAPES_PAGE);
    if (page.length === 0) break;
    for (const row of page) {
      const sampleError = row.sampleError === null ? null : hideSecretShapes(row.sampleError);
      const fingerprintSample = row.fingerprintSample === null ? null : hideSecretShapes(row.fingerprintSample);
      if (sampleError === row.sampleError && fingerprintSample === row.fingerprintSample) continue;
      await db.update(failureClusters).set({ sampleError, fingerprintSample }).where(eq(failureClusters.id, row.id));
      hidden++;
    }
    after = page.at(-1)!.id;
  }
  for (let after = 0; ;) {
    const page = await db
      .select({ id: failureClusterAliases.id, fingerprintSample: failureClusterAliases.fingerprintSample })
      .from(failureClusterAliases)
      .where(and(gt(failureClusterAliases.id, after), mayHoldSecretShape(failureClusterAliases.fingerprintSample)))
      .orderBy(asc(failureClusterAliases.id))
      .limit(SECRET_SHAPES_PAGE);
    if (page.length === 0) break;
    for (const row of page) {
      const fingerprintSample = row.fingerprintSample === null ? null : hideSecretShapes(row.fingerprintSample);
      if (fingerprintSample === row.fingerprintSample) continue;
      await db.update(failureClusterAliases).set({ fingerprintSample }).where(eq(failureClusterAliases.id, row.id));
      hidden++;
    }
    after = page.at(-1)!.id;
  }
  return hidden;
}
