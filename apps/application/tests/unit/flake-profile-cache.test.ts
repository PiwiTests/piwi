import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const { cachedFlakeProfileSummaries, dropProjectFlakeProfiles, FLAKE_PROFILE_CACHE_TTL_MS } =
  await import('../../server/utils/flake-profile-cache');
const { getFlakeProfileSummaries } = await import('../../shared/handlers/flake-profile');

let queries: string[];
let db: ReturnType<typeof drizzle<typeof schema>>;

const DAY = 24 * 60 * 60 * 1000;
const SHOP = 1;
const BLOG = 2;
// Tests of the shop project, then one of the blog project.
const CART = 1;
const PAY = 2;
const POST = 3;

beforeAll(async () => {
  queries = [];
  db = drizzle(createClient({ url: ':memory:' }), { schema, logger: { logQuery: (q) => queries.push(q) } });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: SHOP, name: 'Shop' },
    { id: BLOG, name: 'Blog' },
  ]);
  await db.insert(schema.testCases).values([
    { id: CART, projectId: SHOP, title: 'fills the cart', filePath: 'cart.spec.ts' },
    { id: PAY, projectId: SHOP, title: 'pays', filePath: 'pay.spec.ts' },
    { id: POST, projectId: BLOG, title: 'posts', filePath: 'post.spec.ts' },
  ]);
  const now = Date.now();
  for (let run = 1; run <= 6; run++) {
    const projectId = run <= 4 ? SHOP : BLOG;
    const start = now - run * DAY;
    await db.insert(schema.testRuns).values({
      id: run,
      projectId,
      status: 'passed',
      startTime: new Date(start),
      origin: 'ci',
    });
    const cases = projectId === SHOP ? [CART, PAY] : [POST];
    await db.insert(schema.testRunsCases).values(
      cases.map((testCaseId, i) => ({
        testRunId: run,
        testCaseId,
        status: run % 2 ? 'failed' : 'passed',
        startedAt: start + i * 1_000,
        duration: 900,
        workerIndex: i,
        createdAt: new Date(start),
      })),
    );
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  dropProjectFlakeProfiles(SHOP);
  dropProjectFlakeProfiles(BLOG);
});

describe('cachedFlakeProfileSummaries', () => {
  test('reads the profiles once, and returns the kept ones in the order asked', async () => {
    const first = await cachedFlakeProfileSummaries(db as never, SHOP, [PAY, CART]);
    expect(first.map((p) => p.testCaseId)).toEqual([PAY, CART]);
    expect(first).toEqual(await getFlakeProfileSummaries(db as never, [PAY, CART]));

    queries.length = 0;
    const again = await cachedFlakeProfileSummaries(db as never, SHOP, [CART, PAY]);
    expect(queries).toEqual([]);
    expect(again.map((p) => p.testCaseId)).toEqual([CART, PAY]);
  });

  test('reads only the tests it does not keep', async () => {
    await cachedFlakeProfileSummaries(db as never, SHOP, [CART]);
    queries.length = 0;
    await cachedFlakeProfileSummaries(db as never, SHOP, [CART, PAY]);
    // One profile read: its test case, then its attempts.
    expect(queries.filter((q) => /from "test_cases" inner join "projects"/.test(q))).toHaveLength(1);
  });

  test('drops a project’s profiles when one of its runs ends, and only that project’s', async () => {
    await cachedFlakeProfileSummaries(db as never, SHOP, [CART, PAY]);
    await cachedFlakeProfileSummaries(db as never, BLOG, [POST]);
    expect(dropProjectFlakeProfiles(SHOP)).toBe(2);

    queries.length = 0;
    await cachedFlakeProfileSummaries(db as never, BLOG, [POST]);
    expect(queries).toEqual([]);
    await cachedFlakeProfileSummaries(db as never, SHOP, [CART]);
    expect(queries.length).toBeGreaterThan(0);
  });

  test('reads a profile again once it has been kept ten minutes', async () => {
    await cachedFlakeProfileSummaries(db as never, SHOP, [CART]);
    const later = Date.now() + FLAKE_PROFILE_CACHE_TTL_MS + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    queries.length = 0;
    await cachedFlakeProfileSummaries(db as never, SHOP, [CART]);
    expect(queries.length).toBeGreaterThan(0);
  });
});
