import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { FailureVerdict } from '#shared/failure-verdict';
import type { Situation } from '#shared/situation';
import type { NextStep } from '#shared/next-step';
import type { DidNotRunExplanation } from '#shared/did-not-run';
import { migrateToLatest } from './temp-db';

/**
 * The execution detail of a test that is not a plain failure, against an
 * in-memory SQLite database. A test that passed on retry: its verdict, the line
 * under the headline and the next step come from its failed attempt's row, and a
 * retry pass whose failed attempt is not stored still gets the retry pass's next
 * step. A test that did not run: its reason as one sentence, with the run's
 * failed count or a link to the test that blocked it, and a next step that opens
 * what stopped it, counting a test that failed on several attempts once.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getTestRunCase } = await import('#shared/handlers/test-cases');

type Detail = {
  verdict: FailureVerdict | null;
  situation: Situation | null;
  nextStep: NextStep | null;
  didNotRun: DidNotRunExplanation | null;
};

const SETTINGS_ERROR = `Error: expect(locator).toHaveAttribute(expected) failed

Locator:  locator('html')
Expected: "dark"
Received: "light"
    at tests/admin/settings.spec.ts:21:31`;

let db: ReturnType<typeof drizzle<typeof schema>>;

async function detail(id: number, opts: { aiConfigured?: boolean } = {}): Promise<Detail> {
  return (await getTestRunCase(db as never, id, null, opts)) as unknown as Detail;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'admin' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, title: 'toggles dark mode', filePath: 'tests/admin/settings.spec.ts' },
    { id: 2, projectId: 1, title: 'saves the profile', filePath: 'tests/admin/profile.spec.ts' },
  ]);
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'passed',
    startTime: new Date('2026-09-01T10:00:00Z'),
    metadata: { scm: { commit: 'a1b2c3d4e5f6', branch: 'main', author: 'Alice Chen' } },
  });
  const failed = { retry: 0, status: 'failed', duration: 2400, startedAt: 1_000 };
  const passed = { retry: 1, status: 'passed', duration: 4800, startedAt: 4_000 };
  await db.insert(schema.testRunsCases).values([
    // The failed first attempt and the passing retry of one test, each its own row.
    {
      id: 10,
      testRunId: 1,
      testCaseId: 1,
      browserName: 'Chromium',
      status: 'failed',
      retries: 0,
      error: SETTINGS_ERROR,
      steps: [{ title: "expect(locator('html')).toHaveAttribute()", duration: 2000, failed: true }],
      attempts: [failed],
    },
    {
      id: 11,
      testRunId: 1,
      testCaseId: 1,
      browserName: 'Chromium',
      status: 'passed',
      retries: 1,
      isNewFlaky: 1,
      steps: [{ title: "expect(locator('html')).toHaveAttribute()", duration: 300 }],
      attempts: [failed, passed],
    },
    // A retry pass whose failed attempt was never stored as its own row.
    {
      id: 12,
      testRunId: 1,
      testCaseId: 2,
      browserName: 'Chromium',
      status: 'passed',
      retries: 1,
      attempts: [failed, passed],
    },
  ]);

  // Run 2 stopped at its failure budget after one failure; run 3 after two.
  await db.insert(schema.testCases).values([
    { id: 3, projectId: 1, title: 'adds the item to the cart', filePath: 'tests/checkout/cart.spec.ts' },
    { id: 4, projectId: 1, title: 'applies the coupon', filePath: 'tests/checkout/coupon.spec.ts' },
    { id: 5, projectId: 1, title: 'checks out the cart', filePath: 'tests/checkout/cart.spec.ts' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 2, projectId: 1, status: 'interrupted', failedTests: 1, startTime: new Date('2026-09-02T10:00:00Z') },
    { id: 3, projectId: 1, status: 'interrupted', failedTests: 2, startTime: new Date('2026-09-03T10:00:00Z') },
  ]);
  const cartError = 'Error: expect(locator).toHaveText(expected) failed\n    at tests/checkout/cart.spec.ts:9:5';
  await db.insert(schema.testRunsCases).values([
    { id: 30, testRunId: 2, testCaseId: 3, status: 'failed', line: 4, column: 3, error: cartError },
    { id: 31, testRunId: 2, testCaseId: 4, status: 'didnotrun', didNotRunReason: 'max-failures' },
    {
      id: 32,
      testRunId: 2,
      testCaseId: 5,
      status: 'didnotrun',
      didNotRunReason: 'previous-failure',
      blockedBy: 'tests/checkout/cart.spec.ts:4:3',
    },
    { id: 40, testRunId: 3, testCaseId: 3, status: 'failed', error: cartError },
    { id: 41, testRunId: 3, testCaseId: 5, status: 'timedOut', error: 'Test timeout of 30000ms exceeded.' },
    { id: 42, testRunId: 3, testCaseId: 4, status: 'didnotrun', didNotRunReason: 'max-failures' },
  ]);

  // Run 4 stopped after one test failed on both its attempts, while another
  // test failed once and passed on retry: one failed test, three failed rows.
  await db.insert(schema.testRuns).values({
    id: 4,
    projectId: 1,
    status: 'interrupted',
    failedTests: 1,
    flakyTests: 1,
    startTime: new Date('2026-09-04T10:00:00Z'),
  });
  await db.insert(schema.testRunsCases).values([
    { id: 50, testRunId: 4, testCaseId: 3, browserName: 'Chromium', status: 'failed', retries: 0, error: cartError },
    { id: 51, testRunId: 4, testCaseId: 3, browserName: 'Chromium', status: 'failed', retries: 1, error: cartError },
    { id: 52, testRunId: 4, testCaseId: 5, browserName: 'Chromium', status: 'failed', retries: 0, error: cartError },
    { id: 53, testRunId: 4, testCaseId: 5, browserName: 'Chromium', status: 'passed', retries: 1 },
    {
      id: 54,
      testRunId: 4,
      testCaseId: 4,
      browserName: 'Chromium',
      status: 'didnotrun',
      didNotRunReason: 'max-failures',
    },
  ]);
});

describe('a test that passed on retry', () => {
  test("leads with its failed attempt's headline, naming that attempt", async () => {
    const d = await detail(11);
    expect(d.verdict?.headline).toBe((await detail(10)).verdict?.headline);
    expect(d.verdict?.headline).toBeTruthy();
    expect(d.verdict?.why).toBe('passed-on-retry');
    expect(d.verdict?.attempt).toEqual({ retry: 0, executionId: 10 });
    expect(d.verdict?.cluster).toBeNull();
  });

  test('says under the headline which attempt failed, linked to it', async () => {
    const since = (await detail(11)).situation!.since;
    expect(since.text).toBe('Newly flaky, failed on attempt 1, passed on attempt 2, on a1b2c3d by Alice Chen');
    expect(since.parts.find((p) => p.kind === 'attempt')).toMatchObject({ id: 10, href: '/test-run-cases/10' });
  });

  test('compares the attempts next, with or without an AI provider', async () => {
    expect((await detail(11)).nextStep?.kind).toBe('compare-attempts');
    expect((await detail(11, { aiConfigured: true })).nextStep?.kind).toBe('compare-attempts');
  });

  test('the failed attempt keeps its own headline, with no attempt named', async () => {
    const d = await detail(10);
    expect(d.verdict?.attempt).toBeNull();
    expect(d.situation?.since.text).not.toContain('attempt');
  });

  test('without its failed attempt stored: no headline, and still the retry pass next step', async () => {
    for (const aiConfigured of [false, true]) {
      const d = await detail(12, { aiConfigured });
      expect(d.verdict).toBeNull();
      expect(d.situation).toBeNull();
      expect(d.nextStep?.kind).toBe('compare-attempts');
    }
  });
});

describe('a test that did not run', () => {
  test("a run cut at its failure budget says how many failed, and opens the run's one failure", async () => {
    for (const aiConfigured of [false, true]) {
      const d = await detail(31, { aiConfigured });
      expect(d.didNotRun).toMatchObject({
        text: 'The run reached its maximum number of failures (1 failed) and stopped before this test started.',
        note: 'Reported by Playwright',
      });
      expect(d.verdict).toBeNull();
      expect(d.nextStep).toMatchObject({
        kind: 'open-run',
        title: 'Open the failure that stopped the run',
        primary: { action: 'open-execution', payload: { executionId: 30 } },
      });
    }
  });

  test('a test that failed on every retry counts once, and its last attempt opens', async () => {
    const d = await detail(54);
    expect(d.didNotRun?.text).toContain('(1 failed)');
    expect(d.nextStep).toMatchObject({
      kind: 'open-run',
      title: 'Open the failure that stopped the run',
      primary: { action: 'open-execution', payload: { executionId: 51 } },
    });
  });

  test("with several failures in the run, it opens the run's failures", async () => {
    const d = await detail(42);
    expect(d.didNotRun?.text).toContain('(2 failed)');
    expect(d.nextStep?.primary).toMatchObject({ action: 'open-run', payload: { runId: 3, tab: 'failure-groups' } });
  });

  test('a test an earlier failure blocked links that failure, and opens it next', async () => {
    const d = await detail(32);
    expect(d.didNotRun?.text).toBe('Skipped after adds the item to the cart failed earlier in the same serial group.');
    expect(d.didNotRun?.parts.find((p) => p.kind === 'test')).toMatchObject({ id: 30, href: '/test-run-cases/30' });
    expect(d.nextStep).toMatchObject({ kind: 'open-blocker', primary: { payload: { executionId: 30 } } });
  });

  test('an execution that ran has no did-not-run sentence', async () => {
    expect((await detail(30)).didNotRun).toBeNull();
    expect((await detail(11)).didNotRun).toBeNull();
  });
});
