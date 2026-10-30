import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { collectRunBundle } = await import('../../shared/export/collect');
const { exportFileName } = await import('../../shared/export/build');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
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
      error: '\x1b[31mTimeoutError: Timeout 5000ms exceeded\x1b[39m\n\nCall log:',
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
  test('lists every test result once, by its final attempt, and marks a pass on a retry as flaky', async () => {
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
      repetition: null,
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
        executionIds: [11],
        diagnosis: null,
      },
    ]);
    expect(bundle.cases.map((c) => c.executionId)).toEqual([11, 14]);
    expect(bundle.truncatedCases).toEqual([]);
  });

  test('lists the failing tests past the cap by name', async () => {
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 1 }))!;
    expect(bundle.cases.map((c) => c.executionId)).toEqual([11]);
    expect(bundle.truncatedCases).toEqual([
      { testCaseId: 3, title: 'logs in', filePath: 'tests/login.spec.ts', browser: 'chromium' },
    ]);
  });

  test('keeps the run row without its per-attempt list, and names the file after the project and branch', async () => {
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 25 }))!;
    expect(bundle.run!.detail).toMatchObject({ id: 7, branch: 'main', environment: 'staging' });
    for (const key of ['testCases', 'streamToken', 'storageStats', 'reports', 'setupSteps', 'project']) {
      expect(bundle.run!.detail).not.toHaveProperty(key);
    }
    expect(bundle.project).toEqual({ id: 1, name: 'shop', label: 'Shop' });
    expect(exportFileName(bundle, 'pdf', 7)).toBe('piwi-run-7-shop-main.pdf');
  });

  test('answers null for a run that does not exist', async () => {
    expect(await collectRunBundle(db as never, 99, { maxCases: 25 })).toBeNull();
  });
});

describe('the bundle of a run export, across browsers and repetitions', () => {
  test('groups each failing result under its own failure cluster, browser by browser', async () => {
    await db.insert(schema.failureClusters).values({
      id: 4,
      projectId: 1,
      fingerprint: 'fp-4',
      signature: 'Strict mode violation',
      errorType: 'strict-mode',
      firstSeenRunId: 7,
      lastSeenRunId: 7,
    });
    await db.insert(schema.testRunsCases).values([
      { id: 20, testRunId: 7, testCaseId: 1, status: 'failed', browserName: 'firefox', failureClusterId: 4 },
      { id: 21, testRunId: 7, testCaseId: 3, status: 'failed', browserName: 'firefox', failureClusterId: 4 },
    ]);
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 25 }))!;
    expect(bundle.run!.groups.map((g) => [g.clusterId, g.executionIds])).toEqual([
      [4, [21, 20]],
      [3, [11]],
    ]);
    // The largest group first, each in file order, then the failure no cluster holds.
    expect(bundle.cases.map((c) => c.executionId)).toEqual([21, 20, 11, 14]);
  });

  test('lists each repetition of a repeated test as a result of its own', async () => {
    await db.insert(schema.testRunsCases).values([
      { id: 30, testRunId: 7, testCaseId: 4, status: 'passed', repeatEachIndex: 1, browserName: 'chromium' },
      { id: 31, testRunId: 7, testCaseId: 4, status: 'failed', repeatEachIndex: 2, browserName: 'chromium' },
    ]);
    const bundle = (await collectRunBundle(db as never, 7, { maxCases: 25 }))!;
    const repeated = bundle.run!.tests.filter((t) => t.testCaseId === 4);
    expect(repeated.map((t) => [t.executionId, t.status, t.repetition])).toEqual([
      [15, 'passed', 1],
      [30, 'passed', 2],
      [31, 'failed', 3],
    ]);
  });
});
