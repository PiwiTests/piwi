import { beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { collectRunBundle } = await import('../../shared/export/collect');
const { exportFileName } = await import('../../shared/export/build');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop', defaultBranch: 'main' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', suitePath: 'Checkout', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds to cart' },
    { id: 3, projectId: 1, filePath: 'tests/login.spec.ts', title: 'logs in' },
    { id: 4, projectId: 1, filePath: 'tests/admin.spec.ts', title: 'lists users' },
  ]);
  await db.insert(schema.testRuns).values({
    id: 7,
    projectId: 1,
    status: 'failed',
    branch: 'main',
    environment: 'staging',
    startTime: new Date('2026-10-28T13:04:00Z'),
    totalTests: 4,
    passedTests: 2,
    failedTests: 2,
    flakyTests: 1,
  });
  await db.insert(schema.failureClusters).values({
    id: 3,
    projectId: 1,
    fingerprint: 'fp-3',
    signature: 'Timeout 5000ms exceeded',
    errorType: 'timeout',
    firstSeenRunId: 7,
    lastSeenRunId: 7,
  });
  await db.insert(schema.testRunsCases).values([
    // Failed on its first attempt and on its retry: the retry decides.
    { id: 10, testRunId: 7, testCaseId: 1, status: 'failed', retries: 0, browserName: 'chromium', error: 'Error: one' },
    {
      id: 11,
      testRunId: 7,
      testCaseId: 1,
      status: 'failed',
      retries: 1,
      browserName: 'chromium',
      error: 'TimeoutError: Timeout 5000ms exceeded\n\nCall log:',
      failureClusterId: 3,
    },
    // Passed on its retry: flaky, not failing.
    {
      id: 12,
      testRunId: 7,
      testCaseId: 2,
      status: 'failed',
      retries: 0,
      browserName: 'chromium',
      error: 'Error: once',
    },
    { id: 13, testRunId: 7, testCaseId: 2, status: 'passed', retries: 1, browserName: 'chromium', duration: 900 },
    // A failure no cluster holds.
    { id: 14, testRunId: 7, testCaseId: 3, status: 'failed', browserName: 'chromium', error: 'Error: boom' },
    { id: 15, testRunId: 7, testCaseId: 4, status: 'passed', browserName: 'chromium', duration: 4200 },
  ]);
});

describe('the bundle of a run export', () => {
  test('lists every test once, by the attempt that decided it, and marks a pass on a retry as flaky', async () => {
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 25 }))!;
    expect(bundle.kind).toBe('run');
    expect(bundle.title).toBe('Run #7');
    expect(bundle.run!.tests.map((t) => [t.executionId, t.status, t.flaky])).toEqual([
      [15, 'passed', false],
      [13, 'passed', true],
      [14, 'failed', false],
      [11, 'failed', false],
    ]);
    expect(bundle.run!.tests.find((t) => t.executionId === 11)).toMatchObject({
      title: 'pays',
      suitePath: ['Checkout'],
      browser: 'chromium',
      error: 'TimeoutError: Timeout 5000ms exceeded',
      failureClusterId: 3,
    });
  });

  test('groups the failures by root cause and details the failing tests, the grouped ones first', async () => {
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 25 }))!;
    expect(bundle.run!.groups).toEqual([
      {
        clusterId: 3,
        title: 'Timeout 5000ms exceeded',
        status: 'open',
        isNew: true,
        flaky: false,
        testCaseIds: [1],
        diagnosis: null,
      },
    ]);
    expect(bundle.cases.map((c) => c.executionId)).toEqual([11, 14]);
    expect(bundle.truncatedCases).toEqual([]);
  });

  test('lists the failing tests past the cap by name', async () => {
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 1 }))!;
    expect(bundle.cases.map((c) => c.executionId)).toEqual([11]);
    expect(bundle.truncatedCases).toEqual([{ testCaseId: 3, title: 'logs in', filePath: 'tests/login.spec.ts' }]);
  });

  test('keeps the run row without its per-attempt list, and names the file after the project and branch', async () => {
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 25 }))!;
    expect(bundle.run!.detail).toMatchObject({ id: 7, branch: 'main', environment: 'staging' });
    expect(bundle.run!.detail).not.toHaveProperty('testCases');
    expect(bundle.run!.detail).not.toHaveProperty('streamToken');
    expect(bundle.project).toEqual({ id: 1, name: 'shop', label: 'Shop' });
    expect(exportFileName(bundle, 'pdf', 7)).toBe('piwi-run-7-shop-main.pdf');
  });

  test('answers null for a run that does not exist', async () => {
    expect(await collectRunBundle(db as never, 99, { maxCases: 25 })).toBeNull();
  });
});
