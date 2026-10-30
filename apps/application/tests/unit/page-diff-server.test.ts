import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before the handler modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;
const { getPageDiff } = await import('../../server/utils/page-diff');
const { getAriaSampling, GREEN_SAMPLE_MAX_AGE_MS } = await import('#shared/handlers/aria-sampling');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

// persistRunCases resolves test-case ids through a process-level cache; each
// test builds a fresh in-memory DB that reuses project id 1, so a stale cached
// id would point at a row in the previous DB. Clear it between tests.
beforeEach(() => {
  for (const projectId of [1, 2]) {
    testCaseCache.invalidate(projectId);
    testSuiteCache.invalidate(projectId);
  }
});

const GREEN_ARIA = '- document:\n  - form "Checkout":\n    - button "Submit order"';
const FAILING_ARIA = '- document:\n  - form "Checkout":\n    - button "Place order"';

const FAILING_ERROR = [
  'Error: locator.click: Timeout 2000ms exceeded.',
  'Call log:',
  "  - waiting for getByRole('button', { name: 'Submit order' })",
  '',
  '    at /repo/tests/checkout.spec.ts:24:60',
].join('\n');

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function freshDb(): Promise<Db> {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  return db;
}

/** Insert a run + one execution row, returning the execution id. */
async function addExecution(
  db: Db,
  opts: {
    runId: number;
    projectId: number;
    testCaseId: number;
    status: string;
    startTime: Date;
    environment?: string | null;
    branch?: string | null;
    aria?: string | null;
    error?: string | null;
    createdAt?: Date;
  },
): Promise<number> {
  await db.insert(schema.testRuns).values({
    id: opts.runId,
    projectId: opts.projectId,
    status: opts.status === 'passed' ? 'passed' : 'failed',
    startTime: opts.startTime,
    environment: opts.environment ?? null,
    branch: opts.branch ?? null,
  });
  const row = await db
    .insert(schema.testRunsCases)
    .values({
      testRunId: opts.runId,
      testCaseId: opts.testCaseId,
      status: opts.status,
      browserName: 'chromium',
      error: opts.error ?? null,
      ariaSnapshot: opts.aria ?? null,
      createdAt: opts.createdAt ?? opts.startTime,
    })
    .returning({ id: schema.testRunsCases.id });
  return row[0]!.id;
}

describe('getPageDiff baseline choice', () => {
  test('diffs the failing snapshot against the last green sample and flags the locator', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'page-diff-project' });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });

    await addExecution(db, {
      runId: 1,
      projectId: 1,
      testCaseId: 1,
      status: 'passed',
      startTime: new Date('2026-09-01T10:00:00Z'),
      environment: 'production',
      aria: GREEN_ARIA,
    });
    const failingId = await addExecution(db, {
      runId: 2,
      projectId: 1,
      testCaseId: 1,
      status: 'failed',
      startTime: new Date('2026-09-02T10:00:00Z'),
      environment: 'production',
      aria: FAILING_ARIA,
      error: FAILING_ERROR,
    });

    const result = await getPageDiff(db, failingId);
    expect(result.status).toBe('ok');
    expect(result.baseline).toBeTruthy();
    expect(result.baseline?.runId).toBe(1);
    expect(result.summary?.renamed).toBe(1);
    const marked = result.hunks?.filter((h) => h.matchesLocator) ?? [];
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ type: 'renamed', oldName: 'Submit order' });
  });

  test('prefers the same-environment green sample over a more recent other-environment one', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'page-diff-env' });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });

    // Older green pass in production (the failing env)…
    await addExecution(db, {
      runId: 1,
      projectId: 1,
      testCaseId: 1,
      status: 'passed',
      startTime: new Date('2026-09-01T10:00:00Z'),
      environment: 'production',
      aria: GREEN_ARIA,
    });
    // …and a newer green pass in staging.
    await addExecution(db, {
      runId: 2,
      projectId: 1,
      testCaseId: 1,
      status: 'passed',
      startTime: new Date('2026-09-03T10:00:00Z'),
      environment: 'staging',
      aria: GREEN_ARIA,
    });
    const failingId = await addExecution(db, {
      runId: 3,
      projectId: 1,
      testCaseId: 1,
      status: 'failed',
      startTime: new Date('2026-09-04T10:00:00Z'),
      environment: 'production',
      aria: FAILING_ARIA,
      error: FAILING_ERROR,
    });

    const result = await getPageDiff(db, failingId);
    expect(result.status).toBe('ok');
    expect(result.baseline?.runId).toBe(1); // production, not the newer staging run
    expect(result.baselineNote).toBeNull();
  });

  test('returns no-green-sample when no passing execution carries a snapshot', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'page-diff-none' });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });
    const failingId = await addExecution(db, {
      runId: 1,
      projectId: 1,
      testCaseId: 1,
      status: 'failed',
      startTime: new Date('2026-09-02T10:00:00Z'),
      aria: FAILING_ARIA,
      error: FAILING_ERROR,
    });
    expect((await getPageDiff(db, failingId)).status).toBe('no-green-sample');
  });

  test('returns no-failure-snapshot when the failure captured no ARIA', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'page-diff-noaria' });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });
    await addExecution(db, {
      runId: 1,
      projectId: 1,
      testCaseId: 1,
      status: 'passed',
      startTime: new Date('2026-09-01T10:00:00Z'),
      aria: GREEN_ARIA,
    });
    const failingId = await addExecution(db, {
      runId: 2,
      projectId: 1,
      testCaseId: 1,
      status: 'failed',
      startTime: new Date('2026-09-02T10:00:00Z'),
      aria: null,
      error: FAILING_ERROR,
    });
    expect((await getPageDiff(db, failingId)).status).toBe('no-failure-snapshot');
  });

  test('returns not-applicable for a passing execution', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'page-diff-pass' });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });
    const passId = await addExecution(db, {
      runId: 1,
      projectId: 1,
      testCaseId: 1,
      status: 'passed',
      startTime: new Date('2026-09-01T10:00:00Z'),
      aria: GREEN_ARIA,
    });
    expect((await getPageDiff(db, passId)).status).toBe('not-applicable');
  });
});

describe('getAriaSampling', () => {
  test('lists tests with a missing or stale green sample, skipping fresh ones', async () => {
    const db = await freshDb();
    const now = new Date('2026-09-05T10:00:00Z').getTime();
    await db.insert(schema.projects).values({ id: 1, name: 'sampling-project' });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'fresh' },
      { id: 2, projectId: 1, filePath: 'tests/b.spec.ts', title: 'stale' },
      { id: 3, projectId: 1, filePath: 'tests/c.spec.ts', title: 'never' },
    ]);
    // Fresh green sample (1 hour ago).
    await addExecution(db, {
      runId: 1,
      projectId: 1,
      testCaseId: 1,
      status: 'passed',
      startTime: new Date(now - 60 * 60 * 1000),
      createdAt: new Date(now - 60 * 60 * 1000),
      aria: GREEN_ARIA,
    });
    // Stale green sample (two days ago).
    await addExecution(db, {
      runId: 2,
      projectId: 1,
      testCaseId: 2,
      status: 'passed',
      startTime: new Date(now - 2 * GREEN_SAMPLE_MAX_AGE_MS),
      createdAt: new Date(now - 2 * GREEN_SAMPLE_MAX_AGE_MS),
      aria: GREEN_ARIA,
    });
    // Test 3 has no green sample at all.

    const { tests } = await getAriaSampling(db, 1, now);
    const titles = tests.map((t) => t.title).sort();
    expect(titles).toEqual(['never', 'stale']);
  });
});

describe('persistRunCases green-sample dedupe', () => {
  test('drops a second green snapshot for a test with a recent one', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'dedupe-project' });

    const run1 = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date('2026-09-05T09:00:00Z') })
      .returning({ id: schema.testRuns.id });
    await persistRunCases(db, 1, run1[0]!.id, [
      { title: 'pays', filePath: 'tests/checkout.spec.ts', status: 'passed', ariaSnapshot: GREEN_ARIA },
    ]);

    const run2 = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date('2026-09-05T10:00:00Z') })
      .returning({ id: schema.testRuns.id });
    await persistRunCases(db, 1, run2[0]!.id, [
      { title: 'pays', filePath: 'tests/checkout.spec.ts', status: 'passed', ariaSnapshot: GREEN_ARIA },
    ]);

    const rows = await db.select().from(schema.testRunsCases);
    const withAria = rows.filter((r) => r.ariaSnapshotPayloadId != null || r.ariaSnapshot != null);
    expect(rows).toHaveLength(2);
    // Only the first green snapshot is kept; the second-in-a-day is dropped.
    expect(withAria).toHaveLength(1);
  });

  test('never drops a failing snapshot', async () => {
    const db = await freshDb();
    await db.insert(schema.projects).values({ id: 1, name: 'dedupe-fail' });
    const run = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'failed', startTime: new Date('2026-09-05T10:00:00Z') })
      .returning({ id: schema.testRuns.id });
    await persistRunCases(db, 1, run[0]!.id, [
      { title: 'pays', filePath: 'tests/checkout.spec.ts', status: 'passed', ariaSnapshot: GREEN_ARIA },
      { title: 'pays', filePath: 'tests/checkout.spec.ts', status: 'failed', ariaSnapshot: FAILING_ARIA },
    ]);
    const rows = await db.select().from(schema.testRunsCases);
    const failing = rows.find((r) => r.status === 'failed')!;
    expect(failing.ariaSnapshotPayloadId != null || failing.ariaSnapshot != null).toBe(true);
  });
});
