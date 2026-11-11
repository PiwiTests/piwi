import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * The test case catalog read from Zephyr, against a stubbed `fetch`: every page is read before anything is stored, the
 * rows the tool no longer lists go only after the last page, a failed read keeps the old catalog whole, a 429 is waited
 * out once or pauses the connection, a 401 marks it failed, and the token is in no log line and no answer.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';
// Fast enough that a few requests per test do not slow it; the limiter has its own test.
process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = '600';

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('apiError', apiError);
const headers: Record<string, string | number> = {};
vi.stubGlobal('setResponseHeader', (_event: FakeEvent, name: string, value: string | number) => {
  headers[name] = value;
});

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.catalog-payload.catalog-signature';
const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/zephyr-scale/${name}.json`, import.meta.url), 'utf8'));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** What the stubbed Zephyr answers: a script per `startAt` of the test case list, and every path requested. */
const zephyr = {
  pages: new Map<string, () => Response>(),
  paths: [] as string[],
};
const standardPages = () => {
  zephyr.pages.clear();
  zephyr.pages.set('0', () => json(fixture('testcases-page-1')));
  zephyr.pages.set('2', () => json(fixture('testcases-page-2')));
};
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    zephyr.paths.push(url.pathname + url.search);
    if (url.pathname.endsWith('/statuses')) return json(fixture('statuses-test-case'));
    if (url.pathname.endsWith('/testcases')) {
      const page = zephyr.pages.get(url.searchParams.get('startAt') ?? '0');
      return page ? page() : json({ message: 'unexpected' }, 404);
    }
    return json({ message: 'unexpected' }, 404);
  }),
);
const casesRequests = () => zephyr.paths.filter((p) => p.includes('/testcases'));

const { readCatalogInfo } = await import('../../server/utils/integrations/test-management/catalog');
const { refreshTestManagementCatalog, dueCatalogs, refreshDueCatalogs, CATALOG_MAX_AGE_MS } =
  await import('../../server/utils/integrations/test-management/catalog-refresh');
const { connectionPausedUntil } = await import('../../server/utils/integrations/connection-pauses');
const { resetLimitersForTests } = await import('../../server/utils/integrations/test-management/limiter');

type Route = (event: FakeEvent) => Promise<any>;
const route = (module: { default: unknown }) => underRoutePermission(state, module.default as Route);
const create = route(await import('../../server/api/integrations/connections/index.post'));
const putBinding = route(await import('../../server/api/projects/[id]/test-management/index.put'));
const refreshRoute = route(await import('../../server/api/projects/[id]/test-management/catalog/refresh.post'));

const as = (
  id: number,
  role: InstanceRole,
  ...grants: Parameters<typeof buildAccessSummary>[1][number][]
): RouteCaller => ({
  user: { id, role, username: `user${id}`, name: null } as unknown as User,
  access: buildAccessSummary(role, grants),
});
const admin = as(1, InstanceRole.ADMINISTRATOR);
const projectAdmin = as(2, InstanceRole.MEMBER, { projectId: 10, role: ProjectRole.PROJECT_ADMIN });
const contributor = as(3, InstanceRole.MEMBER, { projectId: 10, role: ProjectRole.CONTRIBUTOR });
const at = (id: number, body?: unknown): FakeEvent => ({ params: { id: String(id) }, query: {}, body });

async function refusal(promise: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { statusCode, message } = error as { statusCode: number; message: string };
    return { statusCode, message };
  }
  throw new Error('expected a refusal');
}

let db: TempDb;
let close: () => Promise<void>;
let zephyrId: number;
let secondId: number;
let logged: string[];
const sleep = vi.fn(async () => {});

const connect = async (name: string) =>
  (
    await create({
      params: {},
      query: {},
      body: { provider: 'zephyr-scale', name, region: 'us', credentials: { apiToken: TOKEN } },
    })
  ).connection.id as number;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 10, name: 'web' });
  state.caller = admin;
  zephyrId = await connect('Zephyr');
  secondId = await connect('Zephyr two');
});
afterAll(async () => {
  await close();
  vi.unstubAllGlobals();
  delete process.env.PIWI_SECRET_KEY;
  delete process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE;
});
beforeEach(async () => {
  state.caller = projectAdmin;
  standardPages();
  zephyr.paths.length = 0;
  sleep.mockClear();
  resetLimitersForTests();
  logged = [];
  for (const level of ['warn', 'info', 'error', 'log'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
  }
  // A pause is held in memory: a moment far ahead lets every one lapse.
  for (const id of [zephyrId, secondId]) connectionPausedUntil(id, new Date(Date.now() + 1e10));
  await db.delete(schema.projectTestManagement);
  await db.delete(schema.testManagementCases);
  await db.delete(schema.testManagementCatalogReads);
  await db.update(schema.integrationConnections).set({ status: 'unverified', lastError: null });
});
afterEach(() => vi.restoreAllMocks());

const rows = () => db.select().from(schema.testManagementCases);
const connectionRow = async (id: number) =>
  (await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.id, id)))[0]!;
const refresh = (options = {}) => refreshTestManagementCatalog(db, zephyrId, 'SHOP', { sleep, ...options });
const old = (key: string, name: string, when: Date) => ({
  connectionId: zephyrId,
  projectKey: 'SHOP',
  key,
  providerId: '1',
  name,
  statusName: 'Draft',
  folder: null,
  fetchedAt: when,
});

describe('refreshTestManagementCatalog', () => {
  test('reads every page and stores each case with its status, folder and read time', async () => {
    const now = new Date('2026-11-10T09:00:00Z');
    const result = await refresh({ now: () => now });
    expect(result).toEqual({ ok: true, size: 3, fetchedAt: now });
    const stored = (await rows()).sort((a, b) => a.key.localeCompare(b.key));
    expect(stored.map((row) => [row.key, row.name, row.statusName, row.folder])).toEqual([
      ['SHOP-T1', 'Checkout with a saved card', 'Approved', '40001'],
      // A case at the project's root has no folder.
      ['SHOP-T2', 'Search finds a product', 'Draft', null],
      // A status the tool's list does not name stays unnamed rather than guessed.
      ['SHOP-T3', 'Cart keeps items after sign-in', null, '40002'],
    ]);
    expect(stored.every((row) => row.fetchedAt.getTime() === now.getTime())).toBe(true);
    expect(await readCatalogInfo(db, zephyrId, 'SHOP')).toEqual({ size: 3, fetchedAt: now });
  });

  test('a read that finds no cases counts as read, and empties the catalog it replaces', async () => {
    const before = new Date('2026-11-09T09:00:00Z');
    await db.insert(schema.testManagementCases).values(old('SHOP-T99', 'Deleted in the tool', before));
    zephyr.pages.set('0', () => json({ ...fixture('testcases-page-2'), values: [], total: 0, startAt: 0 }));
    const now = new Date('2026-11-10T09:00:00Z');
    expect(await refresh({ now: () => now })).toEqual({ ok: true, size: 0, fetchedAt: now });
    expect(await rows()).toEqual([]);
    expect(await readCatalogInfo(db, zephyrId, 'SHOP')).toEqual({ size: 0, fetchedAt: now });
  });

  test('a project that was never read has no read time, and a read renews the one it had', async () => {
    expect(await readCatalogInfo(db, zephyrId, 'SHOP')).toEqual({ size: 0, fetchedAt: null });
    const first = new Date('2026-11-09T09:00:00Z');
    const second = new Date('2026-11-10T09:00:00Z');
    await refresh({ now: () => first });
    await refresh({ now: () => second });
    expect((await readCatalogInfo(db, zephyrId, 'SHOP')).fetchedAt).toEqual(second);
    expect(await db.select().from(schema.testManagementCatalogReads)).toHaveLength(1);
  });

  test('a catalog stored before reads were recorded is read at the time of its newest case', async () => {
    await db
      .insert(schema.testManagementCases)
      .values([
        old('SHOP-T1', 'a', new Date('2026-11-08T09:00:00Z')),
        old('SHOP-T2', 'b', new Date('2026-11-09T09:00:00Z')),
      ]);
    expect(await readCatalogInfo(db, zephyrId, 'SHOP')).toEqual({
      size: 2,
      fetchedAt: new Date('2026-11-09T09:00:00Z'),
    });
  });

  test('a failed read leaves the recorded read time as it was', async () => {
    const before = new Date('2026-11-09T09:00:00Z');
    await db
      .insert(schema.testManagementCatalogReads)
      .values({ connectionId: zephyrId, projectKey: 'SHOP', fetchedAt: before });
    zephyr.pages.set('0', () => json(fixture('error-server'), 500));
    expect(await refresh()).toMatchObject({ ok: false, status: 502 });
    expect((await readCatalogInfo(db, zephyrId, 'SHOP')).fetchedAt).toEqual(before);
  });

  test('asks for the status names once for the whole read, not once per page', async () => {
    await refresh();
    expect(zephyr.paths.filter((p) => p.includes('/statuses'))).toHaveLength(1);
    expect(casesRequests()).toHaveLength(2);
  });

  test('a case the tool no longer lists is deleted once the last page is read, and the others are renewed', async () => {
    const before = new Date('2026-11-09T09:00:00Z');
    await db
      .insert(schema.testManagementCases)
      .values([old('SHOP-T1', 'Old name', before), old('SHOP-T99', 'Deleted in the tool', before)]);
    const now = new Date('2026-11-10T09:00:00Z');
    await refresh({ now: () => now });
    const stored = await rows();
    expect(stored.map((row) => row.key).sort()).toEqual(['SHOP-T1', 'SHOP-T2', 'SHOP-T3']);
    expect(stored.find((row) => row.key === 'SHOP-T1')).toMatchObject({
      name: 'Checkout with a saved card',
      fetchedAt: now,
    });
  });

  test('another project and another connection keep their rows', async () => {
    const before = new Date('2026-11-09T09:00:00Z');
    await db.insert(schema.testManagementCases).values([
      { ...old('OTHER-T1', 'Other project', before), projectKey: 'OTHER' },
      { ...old('SHOP-T1', 'Other connection', before), connectionId: secondId },
    ]);
    await refresh();
    const stored = await rows();
    expect(stored.find((row) => row.key === 'OTHER-T1')?.name).toBe('Other project');
    expect(stored.find((row) => row.connectionId === secondId)?.name).toBe('Other connection');
  });

  test('a failure on the second page keeps the old catalog whole and its read time', async () => {
    const before = new Date('2026-11-09T09:00:00Z');
    await db
      .insert(schema.testManagementCases)
      .values([old('SHOP-T1', 'Old name', before), old('SHOP-T99', 'Still there', before)]);
    zephyr.pages.set('2', () => json(fixture('error-server'), 500));
    const result = await refresh();
    expect(result).toMatchObject({ ok: false, status: 502 });
    const stored = await rows();
    expect(stored.map((row) => [row.key, row.name, row.fetchedAt.getTime()]).sort()).toEqual([
      ['SHOP-T1', 'Old name', before.getTime()],
      ['SHOP-T99', 'Still there', before.getTime()],
    ]);
    expect((await readCatalogInfo(db, zephyrId, 'SHOP')).fetchedAt).toEqual(before);
    expect((await connectionRow(zephyrId)).lastError).toContain('Catalog read failed');
    expect((await connectionRow(zephyrId)).status).not.toBe('failed');
  });

  test('a 429 that asks for a short wait is waited out once and the page is read again', async () => {
    let calls = 0;
    zephyr.pages.set('2', () =>
      ++calls === 1 ? json({ message: 'slow down' }, 429, { 'Retry-After': '5' }) : json(fixture('testcases-page-2')),
    );
    const result = await refresh();
    expect(result).toMatchObject({ ok: true, size: 3 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(connectionPausedUntil(zephyrId, new Date())).toBeNull();
  });

  test('a 429 that repeats pauses the connection and keeps the old catalog; the next read does not call Zephyr', async () => {
    const before = new Date('2026-11-09T09:00:00Z');
    await db.insert(schema.testManagementCases).values(old('SHOP-T99', 'Still there', before));
    zephyr.pages.set('0', () => json({ message: 'slow down' }, 429, { 'Retry-After': '5' }));
    const now = new Date('2026-11-10T09:00:00Z');
    const result = await refresh({ now: () => now });
    expect(result).toMatchObject({ ok: false, status: 429, pausedUntil: new Date(now.getTime() + 5000) });
    expect(connectionPausedUntil(zephyrId, now)).toEqual(new Date(now.getTime() + 5000));
    expect((await rows()).map((row) => row.key)).toEqual(['SHOP-T99']);

    zephyr.paths.length = 0;
    expect(await refresh({ now: () => now })).toMatchObject({ ok: false, status: 429 });
    expect(zephyr.paths).toEqual([]);
  });

  test('a 429 that asks for more than a minute pauses at once without waiting', async () => {
    zephyr.pages.set('0', () => json({ message: 'slow down' }, 429, { 'Retry-After': '120' }));
    const now = new Date('2026-11-10T09:00:00Z');
    const result = await refresh({ now: () => now });
    expect(result).toMatchObject({ ok: false, status: 429, pausedUntil: new Date(now.getTime() + 120_000) });
    expect(sleep).not.toHaveBeenCalled();
    expect(casesRequests()).toHaveLength(1);
  });

  test('the pause lasts for as long as the tool asked, and no longer', async () => {
    zephyr.pages.set('0', () => json({ message: 'slow down' }, 429, { 'Retry-After': '120' }));
    const now = new Date('2026-11-10T09:00:00Z');
    await refresh({ now: () => now });
    expect(connectionPausedUntil(zephyrId, new Date(now.getTime() + 60_000))).not.toBeNull();
    expect(connectionPausedUntil(zephyrId, new Date(now.getTime() + 121_000))).toBeNull();
  });

  test('a 401 marks the connection failed and keeps the catalog', async () => {
    await db
      .insert(schema.testManagementCases)
      .values(old('SHOP-T99', 'Still there', new Date('2026-11-09T09:00:00Z')));
    zephyr.pages.set('0', () => json(fixture('error-unauthorized'), 401));
    const result = await refresh();
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect((await connectionRow(zephyrId)).status).toBe('failed');
    expect((await rows()).map((row) => row.key)).toEqual(['SHOP-T99']);
  });

  test('a success clears the recorded error of a connection that is not failed', async () => {
    await db
      .update(schema.integrationConnections)
      .set({ lastError: 'Catalog read failed: earlier' })
      .where(eq(schema.integrationConnections.id, zephyrId));
    await refresh();
    expect((await connectionRow(zephyrId)).lastError).toBeNull();
  });

  test('a success clears a failed status and its error, as a successful test does', async () => {
    await db
      .update(schema.integrationConnections)
      .set({ status: 'failed', lastError: 'Zephyr Scale refused the API token (401)' })
      .where(eq(schema.integrationConnections.id, zephyrId));
    expect(await refresh()).toMatchObject({ ok: true });
    expect(await connectionRow(zephyrId)).toMatchObject({ status: 'ok', lastError: null });
  });

  test('a failed write is logged and answers a plain sentence, never the database text', async () => {
    const broken = Object.create(db) as typeof db;
    broken.transaction = (async () => {
      throw new Error('insert into "test_management_cases" values ($1, $2) failed: disk I/O error');
    }) as typeof db.transaction;
    const result = await refreshTestManagementCatalog(broken, zephyrId, 'SHOP', { sleep });
    expect(result).toMatchObject({ ok: false, status: 502, error: 'The catalog was read but could not be saved' });
    const { lastError } = await connectionRow(zephyrId);
    expect(lastError).toBe('Catalog read failed: The catalog was read but could not be saved');
    expect(`${result.ok ? '' : result.error} ${lastError}`).not.toContain('insert into');
    expect(await rows()).toEqual([]);
  });

  test('a read already running for the project is shared, not repeated', async () => {
    const [one, two] = await Promise.all([refresh(), refresh()]);
    expect(one).toBe(two);
    expect(casesRequests()).toHaveLength(2);
  });

  test('a connection that does not exist or is not a test management connection is refused', async () => {
    expect(await refreshTestManagementCatalog(db, 9999, 'SHOP', { sleep })).toMatchObject({ ok: false, status: 404 });
  });

  test('the token is in no log line and no result', async () => {
    zephyr.pages.set('2', () => json(fixture('error-server'), 500));
    const result = await refresh();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(await connectionRow(zephyrId))).not.toContain(TOKEN);
  });
});

describe('pruneTestManagementCatalogs', () => {
  test('removes the cases and read times of a project no binding names, and keeps the rest', async () => {
    const { pruneTestManagementCatalogs } = await import('../../server/utils/retention');
    const when = new Date('2026-11-09T09:00:00Z');
    await db
      .insert(schema.testManagementCases)
      .values([
        old('SHOP-T1', 'Bound', when),
        { ...old('WEB-T1', 'Unbound', when), projectKey: 'WEB' },
        { ...old('SHOP-T1', 'Other connection', when), connectionId: secondId },
      ]);
    await db.insert(schema.testManagementCatalogReads).values([
      { connectionId: zephyrId, projectKey: 'SHOP', fetchedAt: when },
      { connectionId: zephyrId, projectKey: 'WEB', fetchedAt: when },
    ]);
    // A disabled binding still names its project, so its catalog stays.
    await db.insert(schema.projectTestManagement).values({
      projectId: 10,
      connectionId: zephyrId,
      providerProjectKey: 'SHOP',
      enabled: false,
    });

    expect(await pruneTestManagementCatalogs(db)).toBe(3);
    expect((await rows()).map((row) => [row.connectionId, row.projectKey, row.key])).toEqual([
      [zephyrId, 'SHOP', 'SHOP-T1'],
    ]);
    expect((await db.select().from(schema.testManagementCatalogReads)).map((row) => row.projectKey)).toEqual(['SHOP']);
    expect(await pruneTestManagementCatalogs(db)).toBe(0);
  });
});

describe('dueCatalogs and refreshDueCatalogs', () => {
  const bind = (connectionId: number, enabled = true) =>
    db.insert(schema.projectTestManagement).values({
      projectId: 10,
      connectionId,
      providerProjectKey: 'SHOP',
      enabled,
      dryRun: true,
      keySources: { tags: true, externalId: false },
      runScope: { branches: [], environments: [], defaultBranch: true } as never,
      runPolicy: { mode: 'per-run', nameTemplate: '{runId}' },
      statuses: { pass: 'Pass', fail: 'Fail', flaky: null, notExecuted: 'Not Executed' },
      options: { flakyAs: 'pass', skippedAs: null, includeError: false, includeComment: true },
    } as never);
  const now = new Date('2026-11-10T09:00:00Z');

  test('a bound catalog that was never read is due; a fresh one is not; one older than a day is', async () => {
    await bind(zephyrId);
    expect(await dueCatalogs(db, now)).toEqual([{ connectionId: zephyrId, projectKey: 'SHOP' }]);
    await db.insert(schema.testManagementCases).values(old('SHOP-T1', 'x', new Date(now.getTime() - 3_600_000)));
    expect(await dueCatalogs(db, now)).toEqual([]);
    await db.update(schema.testManagementCases).set({ fetchedAt: new Date(now.getTime() - CATALOG_MAX_AGE_MS - 1) });
    expect(await dueCatalogs(db, now)).toHaveLength(1);
  });

  test('a catalog that was read and found no cases is not due again for a day', async () => {
    await bind(zephyrId);
    await db
      .insert(schema.testManagementCatalogReads)
      .values({ connectionId: zephyrId, projectKey: 'SHOP', fetchedAt: new Date(now.getTime() - 3_600_000) });
    expect(await dueCatalogs(db, now)).toEqual([]);
    await db
      .update(schema.testManagementCatalogReads)
      .set({ fetchedAt: new Date(now.getTime() - CATALOG_MAX_AGE_MS - 1) });
    expect(await dueCatalogs(db, now)).toHaveLength(1);
  });

  test('a disabled binding, a failed connection and a paused connection are left alone', async () => {
    await bind(zephyrId, false);
    expect(await dueCatalogs(db, now)).toEqual([]);
    await db.update(schema.projectTestManagement).set({ enabled: true });
    await db
      .update(schema.integrationConnections)
      .set({ status: 'failed' })
      .where(eq(schema.integrationConnections.id, zephyrId));
    expect(await dueCatalogs(db, now)).toEqual([]);
    await db.update(schema.integrationConnections).set({ status: 'unverified' });
    const { pauseConnectionById } = await import('../../server/utils/integrations/actions');
    await pauseConnectionById(db, zephyrId, 60_000, now);
    expect(await dueCatalogs(db, now)).toEqual([]);
  });

  test('a tick reads the due catalogs, and a tick right after finds none due', async () => {
    await bind(zephyrId);
    expect(await refreshDueCatalogs(db, { sleep, now: () => now })).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(await rows()).toHaveLength(3);
    // Nothing is due after the read.
    expect(await refreshDueCatalogs(db, { sleep, now: () => now })).toEqual({ refreshed: 0, failed: 0, skipped: 0 });
  });
});

describe('POST /api/projects/:id/test-management/catalog/refresh', () => {
  test('answers 409 for a project with no binding', async () => {
    expect((await refusal(refreshRoute(at(10)))).statusCode).toBe(409);
    expect(zephyr.paths).toEqual([]);
  });

  test('reads the bound project and answers with its size and read time, never the token', async () => {
    await putBinding(at(10, { connectionId: zephyrId, providerProjectKey: 'SHOP' }));
    const answer = await refreshRoute(at(10));
    expect(answer.size).toBe(3);
    expect(new Date(answer.fetchedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(await rows()).toHaveLength(3);
  });

  test('passes a rate limit on as 429 and a refused token as 502, never 401', async () => {
    await putBinding(at(10, { connectionId: zephyrId, providerProjectKey: 'SHOP' }));
    zephyr.pages.set('0', () => json({ message: 'slow down' }, 429, { 'Retry-After': '120' }));
    expect((await refusal(refreshRoute(at(10)))).statusCode).toBe(429);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(100);
    connectionPausedUntil(zephyrId, new Date(Date.now() + 1e10));
    zephyr.pages.set('0', () => json(fixture('error-unauthorized'), 401));
    expect((await refusal(refreshRoute(at(10)))).statusCode).toBe(502);
  });

  test('needs project:manage', async () => {
    await putBinding(at(10, { connectionId: zephyrId, providerProjectKey: 'SHOP' }));
    state.caller = contributor;
    expect((await refusal(refreshRoute(at(10)))).statusCode).toBe(403);
    expect(state.routePermission).toContain('project:manage');
  });
});
