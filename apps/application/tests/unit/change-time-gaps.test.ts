/**
 * The change-time detectors of a pull request, run on its patches and title: a
 * new error path, a new control and an intent no test mentions, each closed when
 * a later run of the pull request no longer raises it.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { computeChangeTimeGaps } = await import('../../server/utils/scm/change-time-gaps');

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p', defaultBranch: 'main' });
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'passed', startTime: new Date(), branch: 'main' },
    { id: 2, projectId: 1, status: 'passed', startTime: new Date(), branch: 'feature/promo' },
  ]);
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, filePath: 'orders.spec.ts', title: 'places an order' });
  await db.insert(schema.testRunsCases).values({ id: 1, testRunId: 1, testCaseId: 1, status: 'passed' });
  await db.insert(schema.networkRequests).values({
    testRunId: 1,
    testRunsCaseId: 1,
    method: 'POST',
    url: 'https://app.test/api/orders',
    normalizedUrl: '/api/orders',
    status: 201,
  });
  await db.insert(schema.graphNodes).values([
    { projectId: 1, kind: 'route', key: 'POST /api/orders' },
    { projectId: 1, kind: 'page', key: '/checkout' },
  ]);
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    fromKind: 'test',
    fromKey: '1',
    toKind: 'page',
    toKey: '/checkout',
    kind: 'reaches',
    lastSeenAt: new Date(),
  });
});

const changed = [
  {
    filename: 'server/api/orders.post.ts',
    status: 'modified',
    additions: 2,
    deletions: 0,
    patch: '@@ -1 +1,3 @@\n+  if (quantity < 0) throw createError({ statusCode: 422 });\n+  return res.status(201);',
  },
  {
    filename: 'app/pages/checkout.vue',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1 +1,2 @@\n+  <UButton label="Apply promo" />',
  },
];

const run = (title: string | null, files = changed) =>
  computeChangeTimeGaps(db as never, {
    projectId: 1,
    runId: 2,
    prNumber: 7,
    title,
    ticket: null,
    files,
    exposure: {},
  });

const openGaps = async () =>
  (await db.select().from(schema.scenarioGaps))
    .filter((g) => g.status === 'open')
    .map((g) => `${g.detector} ${g.key} #${g.prNumber}`)
    .sort();

describe('computeChangeTimeGaps', () => {
  test('raises a new error path, a new control on a reached page and an intent no test mentions', async () => {
    await run('feat: apply a promo discount');
    expect(await openGaps()).toEqual([
      'intent-without-test intent:feat: apply a promo discount #7',
      'new-control control:/checkout:button "Apply promo" #7',
      'new-error-path route:POST /api/orders:422 #7',
    ]);
  });

  test('a later run of the pull request closes what its change no longer raises', async () => {
    await run('feat: apply a promo discount');
    await db
      .insert(schema.testCases)
      .values({ id: 2, projectId: 1, filePath: 'promo.spec.ts', title: 'applies a promo discount' });
    await run('feat: apply a promo discount', [changed[1]!]);
    expect(await openGaps()).toEqual(['new-control control:/checkout:button "Apply promo" #7']);
  });

  test('a gap the pull request answered closes as acted on, one its change dropped as not detected', async () => {
    await run('feat: apply a promo discount');
    await db.insert(schema.networkRequests).values({
      testRunId: 2,
      testRunsCaseId: 1,
      method: 'POST',
      url: 'https://app.test/api/orders',
      normalizedUrl: '/api/orders',
      status: 422,
    });
    await run('feat: apply a promo discount', [changed[0]!]);
    const reasons = (await db.select().from(schema.scenarioGaps))
      .filter((g) => g.status === 'closed')
      .map((g) => `${g.detector} ${g.closeReason}`)
      .sort();
    expect(reasons).toEqual(['new-control not-detected', 'new-error-path acted-on']);
  });

  test('a status a run already answered with, or an order title a test mentions, raises nothing', async () => {
    await db.insert(schema.networkRequests).values({
      testRunId: 2,
      testRunsCaseId: 1,
      method: 'POST',
      url: 'https://app.test/api/orders',
      normalizedUrl: '/api/orders',
      status: 422,
    });
    await run('fix: places an order twice', [changed[0]!]);
    expect(await openGaps()).toEqual([]);
  });
});
