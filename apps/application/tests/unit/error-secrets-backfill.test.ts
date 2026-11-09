import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { HIDDEN_VALUE } from '@piwitests/core/mask';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules that import it load.
delete process.env.PIWI_DATABASE_URL;
const { getAppSetting, setAppSetting } = await import('../../server/utils/app-settings');
const {
  STORED_ERROR_SECRETS_SETTING,
  hideSecretShapesInClusterSamples,
  hideSecretShapesInStoredErrors,
  hideSecretShapesInStoredErrorsOnce,
} = await import('../../server/utils/error-secrets-backfill');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** Values in a credential's shape, built from parts so no scanner reads them as live keys. */
const KEY = ['pd_', 'a3'.repeat(32)].join('');
const TOKEN = ['Bearer ', 'Zm9vYmFyYmF6cXV4'].join('');

/** An error without a credential, which still holds what a shape starts with in SQLite's case-blind `LIKE`. */
const PLAIN = 'Error: the task timed out after 5000ms\n    at tests/tasks.spec.ts:3:1';

/**
 * Executions stored before ingest hid a credential's shape: "signs in" holds a key in its error, its steps' and its
 * hooks' errors, "pays" a bearer token in its error, "lists" and "ships" none; run 1 kept a key in its errors outside
 * any test.
 */
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/sign-in.spec.ts', title: 'signs in' },
    { id: 2, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' },
    { id: 3, projectId: 1, filePath: 'tests/list.spec.ts', title: 'lists' },
    { id: 4, projectId: 1, filePath: 'tests/ship.spec.ts', title: 'ships' },
  ]);
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    startTime: new Date(),
    runErrors: [{ message: `Error: global setup got ${KEY}`, stack: `    at setup (${KEY}.ts:1:1)`, location: null }],
  });
  const error = `Error: 401 for ${KEY}\n\nReceived: "${KEY}"`;
  await db.insert(schema.testRunsCases).values([
    {
      testRunId: 1,
      testCaseId: 1,
      status: 'failed',
      error,
      steps: [
        { title: 'Expect "toBe"', category: 'expect', duration: 1, error: { message: error, location: 'a.ts:1:1' } },
        { title: 'Click', category: 'pw:api', duration: 1 },
      ],
      stepEvents: [{ title: 'Before Hooks', category: 'hook', status: 'failed', error: `Error: ${KEY}` }],
    },
    { testRunId: 1, testCaseId: 2, status: 'failed', error: `Error: refused ${TOKEN}` },
    {
      testRunId: 1,
      testCaseId: 3,
      status: 'failed',
      error: PLAIN,
      steps: [{ title: 'Wait', category: 'pw:api', duration: 1, error: { message: PLAIN } }],
    },
    {
      testRunId: 1,
      testCaseId: 4,
      status: 'failed',
      error: 'Error: boom',
      // What a shape starts with, in a list of steps none of which has an error.
      steps: [{ title: "Click getByRole('link', { name: 'Ask' })", category: 'pw:api', duration: 1 }],
    },
  ]);
});

async function executions() {
  return db.select().from(schema.testRunsCases).orderBy(asc(schema.testRunsCases.id));
}

describe('hiding the credentials of the errors stored before ingest hid them', () => {
  test('hides each shape in the executions’ errors, steps, hooks and the runs’ errors, and leaves the rest', async () => {
    const before = await executions();
    expect(await hideSecretShapesInStoredErrors(db as never)).toBe(5);

    const [signsIn, pays, lists, ships] = await executions();
    expect(signsIn!.error).toBe(`Error: 401 for ${HIDDEN_VALUE}\n\nReceived: "${HIDDEN_VALUE}"`);
    expect(signsIn!.steps).toEqual([
      {
        title: 'Expect "toBe"',
        category: 'expect',
        duration: 1,
        error: { message: signsIn!.error, location: 'a.ts:1:1' },
      },
      { title: 'Click', category: 'pw:api', duration: 1 },
    ]);
    expect(signsIn!.stepEvents).toEqual([
      { title: 'Before Hooks', category: 'hook', status: 'failed', error: `Error: ${HIDDEN_VALUE}` },
    ]);
    expect(pays!.error).toBe(`Error: refused ${HIDDEN_VALUE}`);
    expect(lists).toEqual(before[2]);
    expect(ships).toEqual(before[3]);
    const [run] = await db.select().from(schema.testRuns);
    expect(run!.runErrors).toEqual([
      {
        message: `Error: global setup got ${HIDDEN_VALUE}`,
        stack: `    at setup (${HIDDEN_VALUE}.ts:1:1)`,
        location: null,
      },
    ]);

    // A second pass finds nothing left to hide.
    expect(await hideSecretShapesInStoredErrors(db as never)).toBe(0);
  });

  test('runs once per instance, and resumes after the last page an earlier start finished', async () => {
    const [signsIn, pays] = await executions();
    // An earlier start went through the executions' errors up to "signs in".
    await setAppSetting(db as never, STORED_ERROR_SECRETS_SETTING, { column: 0, after: signsIn!.id });

    expect(await hideSecretShapesInStoredErrorsOnce(db as never)).toBe(4);
    const [stillKeyed, hidden] = await executions();
    expect(stillKeyed!.error).toBe(signsIn!.error);
    expect(hidden!.error).not.toBe(pays!.error);
    expect(JSON.stringify(stillKeyed!.steps)).not.toContain(KEY);
    expect(await getAppSetting(db as never, STORED_ERROR_SECRETS_SETTING)).toEqual({ doneAt: expect.any(String) });

    // Done: a later start reads nothing.
    expect(await hideSecretShapesInStoredErrorsOnce(db as never)).toBeNull();
    expect((await executions())[0]!.error).toBe(signsIn!.error);
  });

  test('reads only the rows that hold what a shape starts with, and records where each page ended', async () => {
    const pages: unknown[] = [];
    await hideSecretShapesInStoredErrors(db as never, { onPage: async (at) => void pages.push(at) });
    const ids = (await executions()).map((row) => row.id);
    expect(pages).toEqual([
      { column: 0, after: ids[2] },
      { column: 1, after: ids[2] },
      { column: 2, after: ids[0] },
      { column: 3, after: 1 },
    ]);
  });
});

describe('hiding the credentials of the failure clusters’ samples', () => {
  test('hides each shape in a cluster’s samples and an alias’s, and leaves the rest', async () => {
    const [keyed, plain] = await db
      .insert(schema.failureClusters)
      .values([
        {
          projectId: 1,
          fingerprint: 'a',
          signature: 'Error: <N> for pd_<ID>',
          sampleError: `Error: 401 for ${KEY}`,
          fingerprintSample: `Error: 401 for ${KEY}`,
          firstSeenRunId: 1,
          lastSeenRunId: 1,
        },
        {
          projectId: 1,
          fingerprint: 'b',
          signature: 'Error: the task timed out after <N>ms',
          sampleError: PLAIN,
          fingerprintSample: null,
          firstSeenRunId: 1,
          lastSeenRunId: 1,
        },
      ])
      .returning();
    await db.insert(schema.failureClusterAliases).values([
      { projectId: 1, fingerprint: 'c', fingerprintSample: `Error: refused ${TOKEN}`, clusterId: keyed!.id },
      { projectId: 1, fingerprint: 'd', fingerprintSample: PLAIN, clusterId: plain!.id },
    ]);

    expect(await hideSecretShapesInClusterSamples(db as never)).toBe(2);
    const clusters = await db.select().from(schema.failureClusters).orderBy(asc(schema.failureClusters.id));
    expect(clusters.map((c) => [c.sampleError, c.fingerprintSample])).toEqual([
      [`Error: 401 for ${HIDDEN_VALUE}`, `Error: 401 for ${HIDDEN_VALUE}`],
      [PLAIN, null],
    ]);
    const aliases = await db
      .select({ sample: schema.failureClusterAliases.fingerprintSample })
      .from(schema.failureClusterAliases)
      .orderBy(asc(schema.failureClusterAliases.id));
    expect(aliases).toEqual([{ sample: `Error: refused ${HIDDEN_VALUE}` }, { sample: PLAIN }]);
    // Their fingerprints are the recluster's to compute again.
    expect(clusters.map((c) => c.fingerprint)).toEqual(['a', 'b']);
    expect(await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, plain!.id))).toEqual([
      plain,
    ]);
  });
});
