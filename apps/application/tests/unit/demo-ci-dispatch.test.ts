import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const { demoClusterRerunInfo, demoRerunCluster } = await import('~~/app/demo/api/ci-rerun');
const { dispatchRunResult } = await import('~/composables/useCiRerun');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.users).values({ id: 1, username: 'avery', name: 'Avery', password: '', role: 'admin' });
  await db.insert(schema.projects).values({
    id: 1,
    name: 'shop',
    ciRerun: {
      enabled: true,
      actions: [
        {
          id: 'rerun',
          name: 'Re-run failed tests',
          target: {
            type: 'ci-server',
            preset: 'jenkins',
            baseUrl: 'https://jenkins.example.com/',
            fields: { job: 'checkout', ref: 'main' },
          },
          inputs: [],
          accepts: ['tests'],
        },
      ],
      defaults: { rerun: 'rerun' },
    },
  });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    branch: 'main',
    startTime: new Date('2026-09-01T10:00:00Z'),
    metadata: { ci: { provider: 'Jenkins' } },
    origin: 'ci',
  });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp',
    signature: 'Error: declined',
    errorType: 'unknown',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db
    .insert(schema.testRunsCases)
    .values({ testRunId: 1, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium', failureClusterId: 1 });
});

describe('the demo’s CI re-run', () => {
  test('stores the dispatch as the server does, and the cluster’s last re-run reads it', async () => {
    const sent = await demoRerunCluster(db as never, 1, 1);
    expect(sent.dispatch).toMatchObject({
      actionId: 'rerun',
      actionName: 'Re-run failed tests',
      kind: 'tests',
      origin: 'page',
      provider: 'ci-server',
      preset: 'jenkins',
      ref: 'main',
      args: '"/tests/checkout.spec.ts:12" --project="chromium"',
      state: 'dispatched',
      byName: 'Avery',
    });
    expect((await demoClusterRerunInfo(db as never, 1)).lastDispatch?.id).toBe(sent.dispatch!.id);
  });

  test('answers a repeat within ten seconds with 409 and the first dispatch, as the server does', async () => {
    const first = await demoRerunCluster(db as never, 1, 1);
    const repeat = await demoRerunCluster(db as never, 1, 1).catch((e: unknown) => e);
    expect(repeat).toMatchObject({ statusCode: 409, data: { dispatch: { id: first.dispatch!.id } } });
    expect(await db.select().from(schema.ciDispatches)).toHaveLength(1);
  });
});

describe('dispatchRunResult', () => {
  test('says how the run that answered a dispatch stands', () => {
    const run = { id: 7, totalTests: 1, passedTests: 1, failedTests: 0 };
    expect(dispatchRunResult({ ...run, status: 'running' })).toBe('is running');
    expect(dispatchRunResult({ ...run, status: 'passed' })).toBe('passed');
    expect(dispatchRunResult({ ...run, status: 'timedout' })).toBe('failed');
    expect(dispatchRunResult({ ...run, status: 'cancelled' })).toBe('was cancelled');
  });
});
