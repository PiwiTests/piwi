import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getSelectionSuggestions } = await import('../../shared/handlers/selection-suggestions');

let db: ReturnType<typeof drizzle<typeof schema>>;
let caseSeq = 0;
let runSeq = 0;
let clock = 0;

async function seedCase(title: string, opts: { feature?: string | null; tags?: string[] } = {}): Promise<number> {
  const id = ++caseSeq;
  await db.insert(schema.testCases).values({
    id,
    projectId: 1,
    filePath: `tests/${title}.spec.ts`,
    title,
    feature: opts.feature ?? null,
    tags: opts.tags ?? null,
  });
  return id;
}

async function seedExec(
  testCaseId: number,
  status: string,
  opts: { duration?: number; routes?: string[] } = {},
): Promise<void> {
  const runId = ++runSeq;
  await db.insert(schema.testRuns).values({ id: runId, projectId: 1, status: 'passed', startTime: new Date(++clock) });
  const [trc] = await db
    .insert(schema.testRunsCases)
    .values({ testRunId: runId, testCaseId, status, duration: opts.duration ?? null, createdAt: new Date(++clock) })
    .returning({ id: schema.testRunsCases.id });
  for (const route of opts.routes ?? []) {
    await db.insert(schema.networkRequests).values({
      testRunsCaseId: trc!.id,
      testRunId: runId,
      method: 'GET',
      normalizedUrl: route,
      status: 200,
      resourceType: 'fetch',
    });
  }
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'suggestions-project' });
  caseSeq = 0;
  runSeq = 0;
  clock = 0;
});

describe('slow suggestions', () => {
  test('flags a test far past the suite p95, and not one already tagged slow', async () => {
    for (let i = 0; i < 20; i++) {
      const id = await seedCase(`fast${i}`);
      await seedExec(id, 'passed', { duration: 100 });
    }
    const slow = await seedCase('molasses');
    await seedExec(slow, 'passed', { duration: 10000 });
    const taggedSlow = await seedCase('known-slow', { tags: ['slow'] });
    await seedExec(taggedSlow, 'passed', { duration: 12000 });

    const { tags } = await getSelectionSuggestions(db, 1);
    const slowTags = tags.filter((t) => t.kind === 'slow');
    expect(slowTags.map((t) => t.testCaseId)).toContain(slow);
    expect(slowTags.map((t) => t.testCaseId)).not.toContain(taggedSlow);
    expect(slowTags[0]!.evidence[0]).toMatch(/p95/);
  });
});

describe('feature suggestions', () => {
  test('proposes the dominant route family for an unlabeled test', async () => {
    const checkout = await seedCase('pays', { feature: null });
    await seedExec(checkout, 'passed', { duration: 500, routes: ['/checkout/pay', '/checkout/items', '/cart/x'] });
    const labeled = await seedCase('already', { feature: 'billing' });
    await seedExec(labeled, 'passed', { duration: 500, routes: ['/checkout/pay', '/checkout/items'] });

    const { tags } = await getSelectionSuggestions(db, 1);
    const feature = tags.filter((t) => t.kind === 'feature');
    expect(feature.find((t) => t.testCaseId === checkout)?.tag).toBe('checkout');
    // A test that already declares a feature is left alone.
    expect(feature.map((t) => t.testCaseId)).not.toContain(labeled);
  });
});

describe('smoke mining', () => {
  test('covers the route universe with a diminishing-returns curve under budget', async () => {
    const a = await seedCase('a');
    await seedExec(a, 'passed', { duration: 1000, routes: ['/checkout/a', '/checkout/b'] });
    const b = await seedCase('b');
    await seedExec(b, 'passed', { duration: 1000, routes: ['/checkout/a', '/cart/x'] });
    const c = await seedCase('c');
    await seedExec(c, 'passed', { duration: 500, routes: ['/checkout/a'] });

    const { smoke } = await getSelectionSuggestions(db, 1, { budgetMs: 60_000 });
    expect(smoke).not.toBeNull();
    expect(smoke!.totalRoutes).toBe(3);
    expect(smoke!.coveredRoutes).toBe(3);
    // Each pick buys no more new routes than the one before it.
    const news = smoke!.picks.map((p) => p.newRoutes);
    expect(news).toEqual([...news].sort((x, y) => y - x));
    // The picks stay within the time budget.
    expect(smoke!.picks.at(-1)!.cumulativeDurationMs).toBeLessThanOrEqual(60_000);
    expect(smoke!.testCaseIds.length).toBeGreaterThan(0);
  });

  test('a tight budget stops early and covers less', async () => {
    const a = await seedCase('a');
    await seedExec(a, 'passed', { duration: 1000, routes: ['/r1', '/r2'] });
    const b = await seedCase('b');
    await seedExec(b, 'passed', { duration: 1000, routes: ['/r3', '/r4'] });

    const { smoke } = await getSelectionSuggestions(db, 1, { budgetMs: 1000 });
    expect(smoke!.picks.length).toBe(1);
    expect(smoke!.coveredRoutes).toBe(2);
  });

  test('excludes flaky and low-pass-rate tests from the candidate pool', async () => {
    const flaky = await seedCase('flaky');
    await seedExec(flaky, 'passed', { duration: 100, routes: ['/only-here'] });
    await seedExec(flaky, 'passed', { duration: 100, routes: ['/only-here'] });
    // Make it flaky: a retry-pass.
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: flaky, status: 'passed', retries: 1, createdAt: new Date(++clock) });

    const { smoke } = await getSelectionSuggestions(db, 1, { budgetMs: 60_000 });
    // The only route belongs to a flaky test, so the candidate pool is empty.
    expect(smoke).toBeNull();
  });
});
