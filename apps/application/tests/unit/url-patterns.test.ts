import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const {
  addProjectUrlPattern,
  listProjectUrlPatterns,
  listVisibleUrlPatterns,
  replaceProjectUrlPatterns,
  stepNavigationUrl,
  suggestUrlPatterns,
  urlPatternInputSchema,
} = await import('../../shared/handlers/url-patterns');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let shop: number;
let admin: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = () => db as any;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const rows = await db
    .insert(schema.projects)
    .values([{ name: 'shop', label: 'Shop' }, { name: 'admin' }])
    .returning();
  shop = rows[0]!.id;
  admin = rows[1]!.id;
});

describe('validation', () => {
  test('a pattern starts with a scheme or a wildcard', () => {
    expect(urlPatternInputSchema.safeParse({ pattern: 'https://shop.test/**' }).success).toBe(true);
    expect(urlPatternInputSchema.safeParse({ pattern: '**/checkout/*' }).success).toBe(true);
    expect(urlPatternInputSchema.safeParse({ pattern: 'shop.test/**' }).success).toBe(false);
    expect(urlPatternInputSchema.safeParse({ pattern: '  ' }).success).toBe(false);
  });

  test('a path prefix is normalized, and refused with a query, a hash, a URL or a wildcard', () => {
    const parse = (pathPrefix: unknown) =>
      urlPatternInputSchema.safeParse({ pattern: 'https://shop.test/**', pathPrefix });
    expect(parse('app/').data?.pathPrefix).toBe('/app');
    const tests = urlPatternInputSchema.safeParse({ pattern: 'https://shop.test/**', testPathPrefix: 'shop/' });
    expect(tests.data?.testPathPrefix).toBe('/shop');
    expect(
      urlPatternInputSchema.safeParse({ pattern: 'https://shop.test/**', testPathPrefix: '/shop#x' }).success,
    ).toBe(false);
    expect(parse(' /shop//eu ').data?.pathPrefix).toBe('/shop/eu');
    expect(parse('').data?.pathPrefix).toBeNull();
    expect(parse(null).data?.pathPrefix).toBeNull();
    expect(parse(undefined).data?.pathPrefix).toBeNull();
    for (const bad of ['/app?x=1', '/app#top', 'https://shop.test/app', '/app/*', '/a/b/c/d/e']) {
      expect(parse(bad).success).toBe(false);
    }
  });
});

describe('writes', () => {
  test('replace keeps the given order and trims empty labels to null', async () => {
    const result = await replaceProjectUrlPatterns(anyDb(), shop, [
      {
        pattern: 'https://staging.shop.test/**',
        environment: 'staging',
        branch: 'develop',
        pathPrefix: '/app/',
        testPathPrefix: 'v2',
      },
      { pattern: ' https://shop.test/** ', environment: ' ', branch: null, pathPrefix: ' ' },
    ]);
    expect(result.ok).toBe(true);
    const items = await listProjectUrlPatterns(anyDb(), shop);
    expect(items.map((i) => [i.pattern, i.environment, i.branch, i.pathPrefix, i.testPathPrefix])).toEqual([
      ['https://staging.shop.test/**', 'staging', 'develop', '/app', '/v2'],
      ['https://shop.test/**', null, null, null, null],
    ]);
  });

  test('replace refuses a duplicate and an unknown project', async () => {
    expect(
      await replaceProjectUrlPatterns(anyDb(), shop, [
        { pattern: 'https://a.test/**' },
        { pattern: 'https://a.test/**' },
      ]),
    ).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(await replaceProjectUrlPatterns(anyDb(), 9999, [])).toMatchObject({ ok: false, reason: 'not-found' });
  });

  test('add appends and refuses a pattern the project has', async () => {
    await replaceProjectUrlPatterns(anyDb(), shop, [{ pattern: 'https://a.test/**' }]);
    const added = await addProjectUrlPattern(anyDb(), shop, { pattern: 'https://b.test/**', environment: 'qa' });
    expect(added.ok && added.items.map((i) => i.pattern)).toEqual(['https://a.test/**', 'https://b.test/**']);
    expect(await addProjectUrlPattern(anyDb(), shop, { pattern: 'https://b.test/**' })).toMatchObject({
      ok: false,
      reason: 'duplicate',
    });
    const prefixed = await addProjectUrlPattern(anyDb(), shop, { pattern: 'https://c.test/**', pathPrefix: 'app/' });
    expect(prefixed.ok && prefixed.items.map((i) => i.pathPrefix)).toEqual([null, null, '/app']);
    // Another project may use the same pattern.
    expect((await addProjectUrlPattern(anyDb(), admin, { pattern: 'https://b.test/**' })).ok).toBe(true);
  });
});

describe('what the extension reads', () => {
  test('ordered by project then position, filtered by scope, labeled', async () => {
    await replaceProjectUrlPatterns(anyDb(), admin, [{ pattern: 'https://admin.test/**' }]);
    await replaceProjectUrlPatterns(anyDb(), shop, [
      { pattern: 'https://shop.test/b/**', pathPrefix: '/b' },
      { pattern: 'https://shop.test/**', environment: 'prod', testPathPrefix: '/shop' },
    ]);
    const all = await listVisibleUrlPatterns(anyDb(), 'all');
    expect(all.map((p) => [p.projectId, p.pattern])).toEqual([
      [shop, 'https://shop.test/b/**'],
      [shop, 'https://shop.test/**'],
      [admin, 'https://admin.test/**'],
    ]);
    expect(all[0]).toMatchObject({
      projectName: 'shop',
      projectLabel: 'Shop',
      environment: null,
      branch: null,
      pathPrefix: '/b',
      testPathPrefix: null,
    });
    expect(all[1]!.testPathPrefix).toBe('/shop');
    expect(all[2]!.projectLabel).toBe('admin');
    expect((await listVisibleUrlPatterns(anyDb(), new Set([admin]))).map((p) => p.projectId)).toEqual([admin]);
    expect(await listVisibleUrlPatterns(anyDb(), new Set())).toEqual([]);
  });
});

describe('suggestions', () => {
  test('one pattern per visited origin, most visited first, minus covered ones', async () => {
    await db.insert(schema.testRuns).values({
      projectId: shop,
      status: 'passed',
      startTime: new Date(),
      metadata: { htmlReport: { projects: [{ use: { baseURL: 'https://staging.shop.test/app' } }] } },
    } as typeof schema.testRuns.$inferInsert);
    await db.insert(schema.graphNodes).values([
      { projectId: shop, kind: 'page', key: '/cart', attrs: { url: 'https://staging.shop.test/cart' } },
      { projectId: shop, kind: 'page', key: '/pay', attrs: { url: 'https://pay.example.com/checkout' } },
      { projectId: shop, kind: 'page', key: '/x', attrs: null },
      { projectId: shop, kind: 'route', key: 'GET /api', attrs: { url: 'https://api.shop.test/api' } },
    ]);
    const { items: suggestions, covered } = await suggestUrlPatterns(anyDb(), shop);
    expect(covered).toBe(0);
    expect(suggestions.map((s) => s.pattern)).toEqual(['https://staging.shop.test/**', 'https://pay.example.com/**']);
    expect(suggestions[0]).toMatchObject({ sources: ['base-url', 'test-map'], hits: 2, environment: null });

    await replaceProjectUrlPatterns(anyDb(), shop, [{ pattern: 'https://staging.shop.test/**' }]);
    const after = await suggestUrlPatterns(anyDb(), shop);
    expect(after.items.map((s) => s.origin)).toEqual(['https://pay.example.com']);
    expect(after.covered).toBe(1);
    expect(await suggestUrlPatterns(anyDb(), 9999)).toEqual({ items: [], covered: 0 });
  });

  test('each run’s baseURL carries its environment, and every environment is read', async () => {
    const run = (hoursAgo: number, environment: string | null, ...baseUrls: string[]) =>
      ({
        projectId: shop,
        status: 'passed',
        environment,
        startTime: new Date(Date.now() - hoursAgo * 3_600_000),
        metadata: { htmlReport: { projects: baseUrls.map((baseURL) => ({ use: { baseURL } })) } },
      }) as typeof schema.testRuns.$inferInsert;
    // A nightly production run, older than a day of staging runs that push it out of the newest ones.
    await db
      .insert(schema.testRuns)
      .values([
        run(200, 'production', 'https://shop.test/', 'https://shop.test/admin'),
        ...Array.from({ length: 30 }, (_, i) => run(100 - i, 'staging', 'https://staging.shop.test/app')),
        run(50, 'qa', 'https://staging.shop.test/'),
        run(40, ' ', 'http://localhost:3000/'),
        run(30, 'a'.repeat(41), 'https://preview.shop.test/'),
      ]);
    await db
      .insert(schema.graphNodes)
      .values([{ projectId: shop, kind: 'page', key: '/pay', attrs: { url: 'https://pay.example.com/checkout' } }]);

    const { items: suggestions } = await suggestUrlPatterns(anyDb(), shop);
    expect(suggestions.map((s) => [s.origin, s.environment, s.hits])).toEqual([
      // The 17 staging runs among the 20 newest, and one qa run, went there: staging wins.
      ['https://staging.shop.test', 'staging', 18],
      ['http://localhost:3000', null, 1],
      ['https://pay.example.com', null, 1],
      ['https://preview.shop.test', null, 1],
      // Two Playwright projects of one run count once.
      ['https://shop.test', 'production', 1],
    ]);
  });

  test('a run with no baseURL is read for the full addresses its tests opened', async () => {
    const [noBase, withBase] = await db
      .insert(schema.testRuns)
      .values([
        { projectId: shop, status: 'passed', environment: 'qa', startTime: new Date(Date.now() - 60_000) },
        {
          projectId: shop,
          status: 'passed',
          startTime: new Date(),
          metadata: { htmlReport: { projects: [{ use: { baseURL: 'https://shop.test' } }] } },
        },
      ] as Array<typeof schema.testRuns.$inferInsert>)
      .returning();
    const testCaseId = (
      await db.insert(schema.testCases).values({ projectId: shop, title: 'buys', filePath: 'buy.spec.ts' }).returning()
    )[0]!.id;
    const navigate = (params: Record<string, string> | null, subtitle?: string, title = 'Navigate') => ({
      title,
      category: 'navigation',
      duration: 1,
      ...(subtitle ? { subtitle } : {}),
      ...(params ? { params } : {}),
    });
    await db.insert(schema.testRunsCases).values([
      {
        testRunId: noBase!.id,
        testCaseId,
        status: 'passed',
        steps: [
          navigate({ url: 'https://qa.shop.test/cart' }),
          navigate(null, 'https://qa.shop.test/pay'),
          navigate(null, undefined, 'page.goto(https://legacy.shop.test/)'),
          // A path under a baseURL, a click and an API call name no site.
          navigate({ url: '/cart' }),
          { title: 'Click', category: 'action', params: { url: 'https://nope.test/' } },
          { title: 'GET', category: 'api', params: { url: 'https://api.shop.test/items' } },
        ],
      },
      // A run with a baseURL is not read for its steps.
      {
        testRunId: withBase!.id,
        testCaseId,
        status: 'passed',
        steps: [navigate({ url: 'https://other.shop.test/' })],
      },
    ] as Array<typeof schema.testRunsCases.$inferInsert>);

    const { items } = await suggestUrlPatterns(anyDb(), shop);
    expect(items.map((s) => [s.origin, s.environment, s.sources, s.hits])).toEqual([
      ['https://legacy.shop.test', 'qa', ['navigation'], 1],
      ['https://qa.shop.test', 'qa', ['navigation'], 1],
      ['https://shop.test', null, ['base-url'], 1],
    ]);
  });

  test('a run with no baseURL is read for the pages it loaded, one vote per run and site', async () => {
    const runs = await db
      .insert(schema.testRuns)
      .values([
        { projectId: shop, status: 'passed', environment: 'qa', startTime: new Date(Date.now() - 120_000) },
        { projectId: shop, status: 'passed', environment: 'qa', startTime: new Date(Date.now() - 60_000) },
        {
          projectId: shop,
          status: 'passed',
          startTime: new Date(),
          metadata: { htmlReport: { projects: [{ use: { baseURL: 'https://shop.test' } }] } },
        },
      ] as Array<typeof schema.testRuns.$inferInsert>)
      .returning();
    const testCaseId = (
      await db.insert(schema.testCases).values({ projectId: shop, title: 'buys', filePath: 'buy.spec.ts' }).returning()
    )[0]!.id;
    const cases = await db
      .insert(schema.testRunsCases)
      .values(runs.map((run) => ({ testRunId: run.id, testCaseId, status: 'passed' })))
      .returning();
    const load = (index: number, url: string | null, resourceType = 'document') => ({
      testRunsCaseId: cases[index]!.id,
      testRunId: runs[index]!.id,
      method: 'GET',
      url,
      normalizedUrl: url ?? '',
      status: 200,
      resourceType,
    });
    await db.insert(schema.networkRequests).values([
      load(0, 'https://qa.shop.test/cart'),
      load(0, 'https://qa.shop.test/pay'),
      load(1, 'https://qa.shop.test/'),
      load(1, 'https://login.shop.test/authorize'),
      // An API call, an unknown address and a run with a baseURL name no site.
      load(1, 'https://api.shop.test/items', 'fetch'),
      load(1, null),
      load(2, 'https://other.shop.test/'),
    ]);

    const { items } = await suggestUrlPatterns(anyDb(), shop);
    expect(items.map((s) => [s.origin, s.environment, s.sources, s.hits])).toEqual([
      ['https://qa.shop.test', 'qa', ['network'], 2],
      ['https://login.shop.test', 'qa', ['network'], 1],
      ['https://shop.test', null, ['base-url'], 1],
    ]);
  });

  test('a navigation step names its site by params, subtitle or title', () => {
    expect(stepNavigationUrl({ category: 'navigation', params: { url: 'https://a.test/x' } })).toBe('https://a.test/x');
    expect(stepNavigationUrl({ category: 'navigation', subtitle: 'https://b.test/' })).toBe('https://b.test/');
    expect(stepNavigationUrl({ category: 'navigation', title: 'Navigate to "https://c.test/p?q=1"' })).toBe(
      'https://c.test/p?q=1',
    );
    expect(stepNavigationUrl({ category: 'navigation', params: { url: '/x' }, subtitle: '/x' })).toBeNull();
    expect(stepNavigationUrl({ category: 'action', params: { url: 'https://a.test/' } })).toBeNull();
    expect(stepNavigationUrl(null)).toBeNull();
  });
});
