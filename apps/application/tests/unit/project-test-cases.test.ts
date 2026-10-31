import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before the handler
// module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { getProjectTestCases, parseTestCasesQuery } = await import('../../shared/handlers/projects');

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
/** Fresh execution timestamps, spaced a minute apart so ordering is deterministic. */
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60 * 1000);

let db: ReturnType<typeof drizzle<typeof schema>>;

interface RunCaseSeed {
  status: string;
  retries?: number;
  duration?: number | null;
  createdAt: Date;
}

async function seedCase(
  projectId: number,
  runId: number,
  filePath: string,
  suitePath: string,
  title: string,
  runCases: RunCaseSeed[],
): Promise<number> {
  const inserted = await db
    .insert(schema.testCases)
    .values({ projectId, filePath, suitePath, title })
    .returning({ id: schema.testCases.id });
  const caseId = inserted[0]!.id;
  for (const rc of runCases) {
    await db.insert(schema.testRunsCases).values({
      testRunId: runId,
      testCaseId: caseId,
      status: rc.status,
      retries: rc.retries ?? 0,
      duration: rc.duration === undefined ? 1000 : rc.duration,
      createdAt: rc.createdAt,
    });
  }
  return caseId;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);

  await db.insert(schema.projects).values({ id: 1, name: 'catalog-project' });
  await db.insert(schema.projects).values({ id: 2, name: 'other-project' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date(now) });
  await db.insert(schema.testRuns).values({ id: 2, projectId: 2, status: 'passed', startTime: new Date(now) });

  // Flaky: latest 10 executions contain a retry-pass; one plain failure.
  await seedCase(1, 1, 'auth/login.spec.ts', 'Auth\x1fLogin', 'login works', [
    { status: 'passed', createdAt: at(1), duration: 900 },
    { status: 'passed', retries: 2, createdAt: at(2), duration: 1100 },
    { status: 'failed', createdAt: at(3), duration: 2000 },
    { status: 'passed', createdAt: at(4), duration: 1000 },
  ]);
  // Timed out (raw camelCase spelling) on the latest execution.
  await seedCase(1, 1, 'shop/checkout.spec.ts', '', 'checkout total updates', [
    { status: 'timedOut', createdAt: at(1), duration: 30000 },
    { status: 'passed', createdAt: at(60), duration: 800 },
  ]);
  // Stale: only execution happened 40 days ago.
  await seedCase(1, 1, 'legacy/old.spec.ts', '', 'legacy flow still boots', [
    { status: 'passed', createdAt: new Date(now - 40 * DAY_MS), duration: 500 },
  ]);
  // Skipped only: never executed for real.
  await seedCase(1, 1, 'auth/sso.spec.ts', '', 'sso round trip', [
    { status: 'skipped', createdAt: at(5), duration: 0 },
    { status: 'skipped', createdAt: at(90), duration: 0 },
  ]);
  // No executions at all.
  await seedCase(1, 1, 'wip/new.spec.ts', '', 'brand new case', []);
  // didnotrun on the latest execution; zero-duration rows must not drag the average.
  await seedCase(1, 1, 'shop/cart.spec.ts', 'Shop\x1fCart', 'cart badge count', [
    { status: 'didnotrun', createdAt: at(1), duration: 0 },
    { status: 'passed', createdAt: at(2), duration: 400 },
  ]);
  // Different project: must never leak into project 1 results.
  await seedCase(2, 2, 'auth/login.spec.ts', '', 'login works', [{ status: 'passed', createdAt: at(1) }]);
});

describe('getProjectTestCases', () => {
  test('returns a paginated envelope scoped to the project', async () => {
    const page = await getProjectTestCases(db, 1);
    expect(page.total).toBe(6);
    expect(page.items).toHaveLength(6);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
    expect(page.items.every((i: any) => typeof i.suitePath === 'string')).toBe(true);
  });

  test('applies limit and offset with a stable order', async () => {
    const first = await getProjectTestCases(db, 1, { limit: 2, offset: 0 });
    const second = await getProjectTestCases(db, 1, { limit: 2, offset: 2 });
    expect(first.total).toBe(6);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    const ids = [...first.items, ...second.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(4);
  });

  test('pages sorted by file or title carry the same rows and aggregates as one page', async () => {
    const byId = new Map((await getProjectTestCases(db, 1)).items.map((i: any) => [i.id, i]));
    for (const sort of ['file', 'title'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const whole = await getProjectTestCases(db, 1, { sort, dir });
        const pages = [];
        for (const offset of [0, 2, 4])
          pages.push(...(await getProjectTestCases(db, 1, { sort, dir, limit: 2, offset })).items);
        expect(pages.map((i: any) => i.id)).toEqual(whole.items.map((i: any) => i.id));
        for (const item of pages) expect(item).toEqual(byId.get((item as any).id));
      }
    }
    const past = await getProjectTestCases(db, 1, { sort: 'title', limit: 2, offset: 6 });
    expect(past).toEqual({ items: [], total: 6, limit: 2, offset: 6 });
    const filtered = await getProjectTestCases(db, 1, {
      sort: 'title',
      dir: 'asc',
      statuses: ['failed', 'flaky'],
      limit: 1,
      offset: 1,
    });
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((i: any) => i.title)).toEqual(['login works']);
  });

  test('search matches title and file path case-insensitively', async () => {
    const byTitle = await getProjectTestCases(db, 1, { q: 'LOGIN' });
    expect(byTitle.items.map((i: any) => i.title)).toContain('login works');
    const byPath = await getProjectTestCases(db, 1, { q: 'shop/' });
    expect(byPath.total).toBe(2);
    expect(byPath.items.map((i: any) => i.filePath).sort()).toEqual(['shop/cart.spec.ts', 'shop/checkout.spec.ts']);
  });

  test('folds timed-out runs into failedRuns and the failed category', async () => {
    const page = await getProjectTestCases(db, 1, { q: 'checkout' });
    const checkout: any = page.items[0];
    expect(checkout.failedRuns).toBe(1);
    expect(checkout.status).toBe('failed');
    const failedOnly = await getProjectTestCases(db, 1, { statuses: ['failed'] });
    expect(failedOnly.items.map((i: any) => i.title)).toEqual(['checkout total updates']);
    expect(failedOnly.total).toBe(1);
  });

  test('flaky category wins over the latest run status', async () => {
    const flaky = await getProjectTestCases(db, 1, { statuses: ['flaky'] });
    expect(flaky.items.map((i: any) => i.title)).toEqual(['login works']);
    expect((flaky.items[0] as any).recentFlakyRuns).toBe(1);
  });

  test('derives skipped, didnotrun and never-run categories', async () => {
    const page = await getProjectTestCases(db, 1);
    const byTitle = new Map(page.items.map((i: any) => [i.title, i]));
    expect(byTitle.get('sso round trip')!.status).toBe('skipped');
    expect(byTitle.get('cart badge count')!.status).toBe('didnotrun');
    expect(byTitle.get('cart badge count')!.didNotRunRuns).toBe(1);
    expect(byTitle.get('brand new case')!.status).toBe('never-run');
    expect(byTitle.get('brand new case')!.lastRun).toBeNull();
  });

  test('maxAgeDays hides cases not executed within the window, 0 keeps everything', async () => {
    const windowed = await getProjectTestCases(db, 1, { maxAgeDays: 30 });
    expect(windowed.items.map((i: any) => i.title)).not.toContain('legacy flow still boots');
    // The never-run case has no executions, so an age window also hides it.
    expect(windowed.total).toBe(4);
    const all = await getProjectTestCases(db, 1, { maxAgeDays: 0 });
    expect(all.total).toBe(6);
  });

  test('computes pass rate over executed runs only', async () => {
    const page = await getProjectTestCases(db, 1);
    const byTitle = new Map(page.items.map((i: any) => [i.title, i]));
    expect(byTitle.get('login works')!.passRate).toBeCloseTo(0.75);
    expect(byTitle.get('checkout total updates')!.passRate).toBeCloseTo(0.5);
    expect(byTitle.get('sso round trip')!.passRate).toBeNull();
  });

  test('computes average duration over executed runs only', async () => {
    const page = await getProjectTestCases(db, 1, { q: 'cart' });
    const cart: any = page.items[0];
    expect(cart.avgDuration).toBe(400);
    const skippedOnly = await getProjectTestCases(db, 1, { q: 'sso' });
    expect((skippedOnly.items[0] as any).avgDuration).toBeNull();
  });

  test('sorts by pass rate with nulls last in both directions', async () => {
    const ascending = await getProjectTestCases(db, 1, { sort: 'passRate', dir: 'asc' });
    const ascRates = ascending.items.map((i: any) => i.passRate);
    expect(ascRates.slice(0, 4)).toEqual([0.5, 0.75, 1, 1]);
    expect(ascRates.slice(4)).toEqual([null, null]);
    const descending = await getProjectTestCases(db, 1, { sort: 'passRate', dir: 'desc' });
    const descRates = descending.items.map((i: any) => i.passRate);
    expect(descRates.slice(0, 4)).toEqual([1, 1, 0.75, 0.5]);
    expect(descRates.slice(4)).toEqual([null, null]);
  });

  test('normalizes lastRun to epoch milliseconds', async () => {
    const page = await getProjectTestCases(db, 1, { q: 'login' });
    const lastRun = (page.items[0] as any).lastRun;
    expect(typeof lastRun).toBe('number');
    expect(Math.abs(lastRun - at(1).getTime())).toBeLessThan(1000);
  });
});

describe('parseTestCasesQuery', () => {
  test('applies defaults on empty input', () => {
    expect(parseTestCasesQuery(undefined)).toEqual({
      limit: 50,
      offset: 0,
      q: undefined,
      statuses: undefined,
      maxAgeDays: 0,
      sort: 'lastRun',
      dir: 'desc',
    });
  });

  test('parses URLSearchParams input', () => {
    const parsed = parseTestCasesQuery(
      new URLSearchParams('q=login&status=failed,flaky,bogus&maxAgeDays=30&sort=passRate&dir=asc&limit=25&offset=50'),
    );
    expect(parsed).toEqual({
      limit: 25,
      offset: 50,
      q: 'login',
      statuses: ['failed', 'flaky'],
      maxAgeDays: 30,
      sort: 'passRate',
      dir: 'asc',
    });
  });

  test('clamps and whitelists record input', () => {
    const parsed = parseTestCasesQuery({
      limit: '5000',
      offset: '-3',
      q: '  ',
      status: 'nope',
      maxAgeDays: '-5',
      sort: 'DROP TABLE',
      dir: 'sideways',
    });
    expect(parsed).toEqual({
      limit: 1000,
      offset: 0,
      q: undefined,
      statuses: undefined,
      maxAgeDays: 0,
      sort: 'lastRun',
      dir: 'desc',
    });
  });
});
