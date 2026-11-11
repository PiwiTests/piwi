import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * The end-of-run sync of a run's results to Zephyr Scale, against a stubbed `fetch`: what is queued and what is skipped,
 * the marker an upload writes before it is sent, what each answer of the tool leaves on the row, and Sync again.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';
process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = '600';
process.env.PIWI_SITE_URL = 'https://piwi.example.com';

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

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sync-payload.sync-signature';
const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/zephyr-scale/${name}.json`, import.meta.url), 'utf8'));
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

/** What the stubbed Zephyr answers, and every request it received. */
const zephyr = {
  upload: (): Response | Promise<Response> => json(fixture('automation-upload-response')),
  link: (): Response | Promise<Response> => json({ id: 1 }, 201),
  executions: (): Response => json(fixture('testexecutions-page')),
  requests: [] as { method: string; path: string }[],
};
const reset = () => {
  zephyr.upload = () => json(fixture('automation-upload-response'));
  zephyr.link = () => json({ id: 1 }, 201);
  zephyr.executions = () => json(fixture('testexecutions-page'));
  zephyr.requests.length = 0;
};
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    zephyr.requests.push({ method, path: url.pathname });
    if (method === 'POST' && url.pathname.endsWith('/automations/executions/custom')) return zephyr.upload();
    if (method === 'POST' && url.pathname.endsWith('/links/weblinks')) return zephyr.link();
    if (url.pathname.endsWith('/testexecutions')) return zephyr.executions();
    if (url.pathname.endsWith('/testcycles/3001')) return json(fixture('testcycle-piwi'));
    if (url.pathname.endsWith('/testcycles/2999')) return json(fixture('testcycle-other'));
    return json({ message: 'unexpected' }, 404);
  }),
);
const calls = (suffix: string) => zephyr.requests.filter((request) => request.path.endsWith(suffix));
const uploads = () => calls('/automations/executions/custom');
const links = () => calls('/links/weblinks');

const { runTestManagementSync } = await import('../../server/utils/integrations/automation');
const { runAction, runActionNow, sweepIntegrationActions } = await import('../../server/utils/integrations/actions');
const { writeTestManagementBinding } = await import('../../server/utils/integrations/test-management/binding');
const { SKIP_CATALOG_NOT_READ, SKIP_NO_MAPPED_CASES } =
  await import('../../server/utils/integrations/test-management/sync');
const { OUTBOX_MAX_ATTEMPTS } = await import('../../server/utils/outbox');
const { connectionPausedUntil } = await import('../../server/utils/integrations/connection-pauses');
const { sendDemoRunSync } = await import('../../app/demo/api/test-management');
const { limiterForConnection, RequestLimiterBusyError, resetLimitersForTests } =
  await import('../../server/utils/integrations/test-management/limiter');
const { createConnection } = await import('../../server/utils/integrations/connections');
const { buildIssueDraft } = await import('../../server/utils/integrations/draft');

type Route = (event: FakeEvent) => Promise<any>;
const route = (module: { default: unknown }) => underRoutePermission(state, module.default as Route);
const create = route(await import('../../server/api/integrations/connections/index.post'));
const syncAgain = route(await import('../../server/api/test-runs/[id]/test-management-sync.post'));
const readSync = route(await import('../../server/api/test-runs/[id]/test-management-sync.get'));

const as = (
  id: number,
  role: InstanceRole,
  ...grants: Parameters<typeof buildAccessSummary>[1][number][]
): RouteCaller => ({
  user: { id, role, username: `user${id}`, name: null } as unknown as User,
  access: buildAccessSummary(role, grants),
});
const admin = as(1, InstanceRole.ADMINISTRATOR);
const maintainer = as(2, InstanceRole.MEMBER, { projectId: 10, role: ProjectRole.MAINTAINER });
const contributor = as(3, InstanceRole.MEMBER, { projectId: 10, role: ProjectRole.CONTRIBUTOR });
const at = (id: number): FakeEvent => ({ params: { id: String(id) }, query: {} });

async function refusal(promise: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { statusCode, message } = error as { statusCode: number; message: string };
    return { statusCode, message };
  }
  throw new Error('expected a refusal');
}

/** The run the tests sync; `findRun` looks for `Piwi #12`, the name the cycle fixture carries. */
const RUN_ID = 12;
const OLD = new Date('2026-11-10T09:00:00Z');

let db: TempDb;
let close: () => Promise<void>;
let zephyrId: number;
let logged: string[];

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 10, name: 'web' });
  state.caller = admin;
  zephyrId = (
    await create({
      params: {},
      query: {},
      body: { provider: 'zephyr-scale', name: 'Zephyr', region: 'us', credentials: { apiToken: TOKEN } },
    })
  ).connection.id as number;
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 10, title: 'pays', filePath: 'tests/pay.spec.ts' },
    { id: 2, projectId: 10, title: 'searches', filePath: 'tests/search.spec.ts' },
    { id: 3, projectId: 10, title: 'has a typo', filePath: 'tests/typo.spec.ts' },
    { id: 4, projectId: 10, title: 'carries no key', filePath: 'tests/none.spec.ts' },
  ]);
});
afterAll(async () => {
  await close();
  vi.unstubAllGlobals();
  delete process.env.PIWI_SECRET_KEY;
  delete process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE;
  delete process.env.PIWI_SITE_URL;
});

const bind = (extra: Record<string, unknown> = {}) =>
  writeTestManagementBinding(db, 10, {
    connectionId: zephyrId,
    providerProjectKey: 'SHOP',
    enabled: true,
    dryRun: false,
    ...extra,
  });

/** One test-run row, a CI run by default, with an attempt per test. */
async function seedRun(
  options: { origin?: 'ci' | 'local'; isFullRun?: number; branch?: string; tags?: Record<number, string[]> } = {},
) {
  const { origin = 'ci', isFullRun = 1, branch = 'main', tags = {} } = options;
  await db.insert(schema.testRuns).values({
    id: RUN_ID,
    projectId: 10,
    status: 'failed',
    startTime: new Date('2026-11-11T08:30:00Z'),
    isFullRun,
    branch,
    origin,
    metadata: origin === 'ci' ? { ci: { buildNumber: '4711' }, scm: { commit: 'abcdef0123456789' } } : {},
  } as never);
  const statuses: Record<number, string> = { 1: 'passed', 2: 'failed', 3: 'passed', 4: 'passed' };
  const defaults: Record<number, string[]> = { 1: ['SHOP-T1'], 2: ['SHOP-T2'], 3: ['SHOP-T9'], 4: [] };
  await db.insert(schema.testRunsCases).values(
    [1, 2, 3, 4].map((id) => ({
      testRunId: RUN_ID,
      testCaseId: id,
      status: statuses[id]!,
      tags: tags[id] ?? defaults[id]!,
    })),
  );
}

const readCatalog = () =>
  db.insert(schema.testManagementCatalogReads).values({ connectionId: zephyrId, projectKey: 'SHOP', fetchedAt: OLD });
const catalogCase = (key: string) => ({
  connectionId: zephyrId,
  projectKey: 'SHOP',
  key,
  providerId: key.slice(-1),
  name: key,
  statusName: 'Approved',
  folder: null,
  fetchedAt: OLD,
});
const fillCatalog = async () => {
  await readCatalog();
  await db.insert(schema.testManagementCases).values(['SHOP-T1', 'SHOP-T2', 'SHOP-T3'].map(catalogCase));
};

const syncRows = () =>
  db
    .select()
    .from(schema.integrationActions)
    .where(and(eq(schema.integrationActions.kind, 'sync-results'), eq(schema.integrationActions.entityId, RUN_ID)));
const syncRow = async () => (await syncRows())[0]!;
const testRunLinks = () => db.select().from(schema.entityLinks).where(eq(schema.entityLinks.testRunId, RUN_ID));

beforeEach(async () => {
  state.caller = maintainer;
  reset();
  resetLimitersForTests();
  logged = [];
  for (const level of ['warn', 'info', 'error', 'log'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
  }
  // A pause is held in memory: a moment far ahead lets it lapse.
  connectionPausedUntil(zephyrId, new Date(Date.now() + 1e10));
  await db.delete(schema.integrationActions);
  await db.delete(schema.entityLinks);
  await db.delete(schema.testRunsCases);
  await db.delete(schema.testRuns);
  await db.delete(schema.projectTestManagement);
  await db.delete(schema.testManagementCases);
  await db.delete(schema.testManagementCatalogReads);
  await db.update(schema.integrationConnections).set({ status: 'unverified', lastError: null });
});
afterEach(() => vi.restoreAllMocks());

describe('what a finished run queues', () => {
  test('sends one result per key the catalog holds, links the test cycle and the run, and records both', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    const action = await runTestManagementSync(db, RUN_ID);
    expect(action).not.toBeNull();

    const row = await syncRow();
    expect(row).toMatchObject({ status: 'done', entityType: 'test_run', entityId: RUN_ID, projectId: 10 });
    expect(row.dedupeKey).toBe(`sync-results:test_run:${RUN_ID}:conn${zephyrId}`);
    expect(row.result).toEqual({
      runKey: 'SHOP-R42',
      runUrl: '',
      sent: 2,
    });
    expect((row.payload as any).results).toEqual([
      { key: 'SHOP-T1', status: 'Pass' },
      { key: 'SHOP-T2', status: 'Fail' },
    ]);
    // A key the catalog lacks is reported, never sent; a test without a key is only counted.
    expect(row.payload).toMatchObject({ unknownKeys: ['SHOP-T9'], unmappedCount: 1, counts: { passed: 1, failed: 1 } });
    expect(uploads()).toHaveLength(1);
    expect(links()).toHaveLength(1);
    expect(links()[0]!.path).toBe('/v2/testcycles/SHOP-R42/links/weblinks');
    // Zephyr names the test cycle by its API address only, which opens no page: the link keeps the key alone.
    expect(await testRunLinks()).toMatchObject([
      { provider: 'zephyr-scale', key: 'SHOP-R42', url: '', testRunId: RUN_ID },
    ]);
  });

  test('the test cycle it links is not offered as an issue the run already has', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    const jira = await createConnection(db, {
      provider: 'jira',
      name: 'Jira',
      baseUrl: 'https://acme.atlassian.net',
      credentials: { email: 'ci@example.com', apiToken: 'token' },
    });
    try {
      await db.insert(schema.entityLinks).values({
        testRunId: RUN_ID,
        provider: 'jira',
        key: 'PROJ-7',
        url: 'https://acme.atlassian.net/browse/PROJ-7',
        connectionId: jira.id,
        origin: 'linked',
      } as never);
      const draft = await buildIssueDraft(db, 'test_run', RUN_ID);
      expect(draft?.existing.map((candidate) => candidate.key)).toEqual(['PROJ-7']);
    } finally {
      await db.delete(schema.entityLinks);
      await db.delete(schema.integrationConnections).where(eq(schema.integrationConnections.id, jira.id));
    }
  });

  test('a run already synced queues nothing again', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    expect(await runTestManagementSync(db, RUN_ID)).toBeNull();
    expect(await syncRows()).toHaveLength(1);
    expect(uploads()).toHaveLength(1);
  });

  test('a dry run stores the payload it would send and makes no call', async () => {
    await seedRun();
    await fillCatalog();
    await bind({ dryRun: true });
    await runTestManagementSync(db, RUN_ID);

    const row = await syncRow();
    expect(row.status).toBe('done');
    expect(row.result).toMatchObject({ dryRun: true, payload: { results: [{ key: 'SHOP-T1' }, { key: 'SHOP-T2' }] } });
    expect(zephyr.requests).toEqual([]);
    expect(await testRunLinks()).toEqual([]);
  });

  test('a catalog never read skips the sync and says why, with no marker', async () => {
    await seedRun();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    expect(await syncRow()).toMatchObject({ status: 'skipped', error: SKIP_CATALOG_NOT_READ, result: null });
    expect(zephyr.requests).toEqual([]);
  });

  test('a run none of whose keys the catalog holds is skipped as having no mapped test cases', async () => {
    await seedRun({ tags: { 1: ['SHOP-T8'], 2: ['SHOP-T9'] } });
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    expect(await syncRow()).toMatchObject({ status: 'skipped', error: SKIP_NO_MAPPED_CASES, result: null });
    expect(zephyr.requests).toEqual([]);
  });

  test.each([
    ['a binding that is off', { enabled: false }, {}],
    ['a run from a developer machine', {}, { origin: 'local' as const }],
    ['a partial run', {}, { isFullRun: 0 }],
    ['a branch outside the run scope', { runScope: { branches: ['release'] } }, {}],
  ])('queues nothing for %s', async (_name, binding, run) => {
    await seedRun(run);
    await fillCatalog();
    await bind(binding);
    expect(await runTestManagementSync(db, RUN_ID)).toBeNull();
    expect(await syncRows()).toEqual([]);
    expect(zephyr.requests).toEqual([]);
  });

  test('a project with no binding queues nothing', async () => {
    await seedRun();
    expect(await runTestManagementSync(db, RUN_ID)).toBeNull();
    expect(await runTestManagementSync(db, 999)).toBeNull();
  });
});

describe('an attempt, step by step', () => {
  test('the upload start is on the row before the call, and the test cycle right after it', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    const seen: unknown[] = [];
    zephyr.upload = async () => {
      seen.push((await syncRow()).result);
      return json(fixture('automation-upload-response'));
    };
    zephyr.link = async () => {
      seen.push((await syncRow()).result);
      return json({ id: 1 }, 201);
    };
    await runTestManagementSync(db, RUN_ID);
    expect(seen[0]).toEqual({ uploadStartedAt: expect.any(Number) });
    expect(seen[1]).toEqual({
      uploadStartedAt: expect.any(Number),
      runKey: 'SHOP-R42',
      runUrl: '',
    });
  });

  test('a link that fails after the upload retries the link only, never the upload', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    zephyr.link = () => json({ message: 'down' }, 500);
    await runTestManagementSync(db, RUN_ID);
    const retrying = await syncRow();
    expect(retrying).toMatchObject({ status: 'pending', attempts: 1 });
    expect(retrying.result).toMatchObject({ runKey: 'SHOP-R42' });

    zephyr.link = () => json({ id: 1 }, 201);
    await runActionNow(db, retrying.id);
    expect(await syncRow()).toMatchObject({ status: 'done', result: { runKey: 'SHOP-R42', sent: 2 } });
    expect(uploads()).toHaveLength(1);
    expect(links()).toHaveLength(2);
  });

  test('a run without an address in Piwi is uploaded with no link back', async () => {
    delete process.env.PIWI_SITE_URL;
    try {
      await seedRun();
      await fillCatalog();
      await bind();
      await runTestManagementSync(db, RUN_ID);
      expect((await syncRow()).status).toBe('done');
      expect(links()).toHaveLength(0);
    } finally {
      process.env.PIWI_SITE_URL = 'https://piwi.example.com';
    }
  });

  test('the token is in no log line and no stored row', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    zephyr.upload = () => json({ message: 'nope' }, 400);
    await runTestManagementSync(db, RUN_ID);
    expect(JSON.stringify(await syncRows())).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});

describe('what each failure of the upload leaves', () => {
  const attempt = async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    return syncRow();
  };

  test('a 429 clears the marker, backs off for the time the tool names and pauses the connection', async () => {
    zephyr.upload = () => json({ message: 'slow down' }, 429, { 'Retry-After': '120' });
    const before = Date.now();
    const row = await attempt();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, result: null });
    expect(row.scheduledFor.getTime()).toBeGreaterThanOrEqual(before + 119_000);
    expect(connectionPausedUntil(zephyrId, new Date())).not.toBeNull();
    expect(uploads()).toHaveLength(1);
  });

  test('a busy request queue backs off for the wait it names and leaves the connection open', async () => {
    vi.spyOn(limiterForConnection(zephyrId), 'wait').mockRejectedValueOnce(new RequestLimiterBusyError(30_000));
    const before = Date.now();
    const row = await attempt();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, result: null });
    expect(row.scheduledFor.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(connectionPausedUntil(zephyrId, new Date())).toBeNull();
    expect(uploads()).toHaveLength(0);
  });

  test.each([500, 502, 503, 504])('a %i fails at once as Outcome unknown and keeps the marker', async (status) => {
    zephyr.upload = () => json({ message: 'down' }, status);
    const row = await attempt();
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^Outcome unknown: check the test management tool for a test run named "/);
    expect(row.error).toContain('Piwi #12');
    expect(row.result).toEqual({ uploadStartedAt: expect.any(Number) });
    expect(uploads()).toHaveLength(1);
  });

  test('a lost connection is Outcome unknown too', async () => {
    zephyr.upload = () => Promise.reject(new TypeError('fetch failed'));
    const row = await attempt();
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^Outcome unknown/);
    expect(row.result).toEqual({ uploadStartedAt: expect.any(Number) });
  });

  test.each([400, 403, 404, 413, 422])('a %i is final, and the marker goes with it', async (status) => {
    zephyr.upload = () => json({ message: 'refused' }, status);
    const row = await attempt();
    expect(row).toMatchObject({ status: 'failed', result: null });
    expect(row.error).not.toMatch(/^Outcome unknown/);
    expect(uploads()).toHaveLength(1);
    const [connection] = await db.select().from(schema.integrationConnections);
    expect(connection!.status).not.toBe('failed');
  });

  test('a 401 is final and marks the connection failed', async () => {
    zephyr.upload = () => json(fixture('error-unauthorized'), 401);
    const row = await attempt();
    expect(row).toMatchObject({ status: 'failed', result: null });
    const [connection] = await db.select().from(schema.integrationConnections);
    expect(connection!.status).toBe('failed');
  });

  test('the sweep never sends a row that holds an upload start and no test cycle', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    zephyr.upload = () => json({ message: 'down' }, 503);
    await runTestManagementSync(db, RUN_ID);
    const failed = await syncRow();
    await db
      .update(schema.integrationActions)
      .set({ status: 'pending', error: null, scheduledFor: new Date(0), finishedAt: null })
      .where(eq(schema.integrationActions.id, failed.id));
    zephyr.requests.length = 0;

    await sweepIntegrationActions(db);
    expect(zephyr.requests).toEqual([]);
    expect(await syncRow()).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Outcome unknown/) });
  });

  test('a row given up while it held an upload start fails as Outcome unknown', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    const done = await syncRow();
    await db
      .update(schema.integrationActions)
      .set({
        status: 'processing',
        attempts: OUTBOX_MAX_ATTEMPTS,
        result: { uploadStartedAt: Date.now() - 3_600_000 } as never,
        scheduledFor: new Date(Date.now() - 3_600_000),
        finishedAt: null,
        error: null,
      })
      .where(eq(schema.integrationActions.id, done.id));
    zephyr.requests.length = 0;

    await sweepIntegrationActions(db);
    expect(await syncRow()).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Outcome unknown/) });
    expect(zephyr.requests).toEqual([]);
  });

  test('a row that holds a test cycle and is retried resumes at the link', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    const done = await syncRow();
    await db
      .update(schema.integrationActions)
      .set({
        status: 'pending',
        result: { uploadStartedAt: 1, runKey: 'SHOP-R42', runUrl: 'https://x.example/SHOP-R42' } as never,
        finishedAt: null,
      })
      .where(eq(schema.integrationActions.id, done.id));
    zephyr.requests.length = 0;

    const claimed = await runActionNow(db, done.id);
    expect(claimed).toMatchObject({ status: 'done' });
    expect(uploads()).toEqual([]);
    expect(links()).toHaveLength(1);
  });

  test('runAction on a reclaimed row with an upload start and no test cycle sends nothing', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    const done = await syncRow();
    zephyr.requests.length = 0;
    const outcome = await runAction(db, {
      ...done,
      status: 'running',
      result: { uploadStartedAt: Date.now() } as never,
    });
    expect(outcome).toMatchObject({ status: 'failed', final: true });
    expect(zephyr.requests).toEqual([]);
  });
});

describe('Sync again', () => {
  const failUpload = async (status: number) => {
    await seedRun();
    await fillCatalog();
    await bind();
    zephyr.upload = () => json({ message: 'down' }, status);
    await runTestManagementSync(db, RUN_ID);
    reset();
  };

  test('an upload that ended without an answer looks for the cycle first and links the one it finds', async () => {
    await failUpload(503);
    const answer = await syncAgain(at(RUN_ID));
    expect(answer).toEqual({
      status: 'done',
      result: {
        runKey: 'SHOP-R42',
        runUrl: '',
        sent: 2,
      },
    });
    expect(uploads()).toEqual([]);
    expect(links()).toHaveLength(1);
    expect(await testRunLinks()).toMatchObject([{ key: 'SHOP-R42' }]);
  });

  test('no cycle found uploads again', async () => {
    await failUpload(503);
    zephyr.executions = () => json({ ...fixture('testexecutions-page'), values: [], total: 0 });
    expect(await syncAgain(at(RUN_ID))).toMatchObject({ status: 'done', result: { runKey: 'SHOP-R42' } });
    expect(uploads()).toHaveLength(1);
  });

  test('a cycle that belongs to another run is not taken for this one', async () => {
    await failUpload(503);
    zephyr.executions = () =>
      json({
        ...fixture('testexecutions-page'),
        values: [{ id: 1, testCycle: { id: 2999, self: 'https://api.zephyrscale.smartbear.com/v2/testcycles/2999' } }],
      });
    await syncAgain(at(RUN_ID));
    expect(uploads()).toHaveLength(1);
  });

  test('a sync that failed before sending is sent again without a search', async () => {
    await failUpload(422);
    expect(await syncAgain(at(RUN_ID))).toMatchObject({ status: 'done' });
    expect(calls('/testexecutions')).toEqual([]);
    expect(uploads()).toHaveLength(1);
  });

  test('a second upload that fails the same way fails as Outcome unknown again', async () => {
    await failUpload(503);
    zephyr.executions = () => json({ ...fixture('testexecutions-page'), values: [], total: 0 });
    zephyr.upload = () => json({ message: 'down' }, 504);
    expect(await syncAgain(at(RUN_ID))).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Outcome/) });
    expect((await syncRow()).result).toEqual({ uploadStartedAt: expect.any(Number) });
  });

  test('a run with no failed sync is a 409', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    expect((await refusal(syncAgain(at(RUN_ID)))).statusCode).toBe(409);
  });

  test('a project that no longer sends through the connection is a 409', async () => {
    await failUpload(422);
    await bind({ enabled: false });
    expect((await refusal(syncAgain(at(RUN_ID)))).statusCode).toBe(409);
    expect(zephyr.requests).toEqual([]);
  });

  test('a missing run is a 404', async () => {
    expect((await refusal(syncAgain(at(999)))).statusCode).toBe(404);
  });

  test('takes run:control: a contributor is refused, and the sync stays failed', async () => {
    await failUpload(422);
    state.caller = contributor;
    expect((await refusal(syncAgain(at(RUN_ID)))).statusCode).toBe(403);
    expect((await syncRow()).status).toBe('failed');
    expect(zephyr.requests).toEqual([]);
  });
});

describe('what the run page reads', () => {
  const queued = async (dryRun = false) => {
    await seedRun();
    await fillCatalog();
    await bind({ dryRun });
    await runTestManagementSync(db, RUN_ID);
  };

  test('a run with no sync reads null', async () => {
    await seedRun();
    expect(await readSync(at(RUN_ID))).toEqual({ sync: null });
  });

  test('a sent sync reads the cycle it made and the counts it sent', async () => {
    await queued();
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({
      status: 'done',
      dryRun: false,
      outcomeUnknown: false,
      runKey: 'SHOP-R42',
      resultCount: 2,
      counts: { passed: 1, failed: 1, flaky: 0, notExecuted: 0 },
      unknownKeys: ['SHOP-T9'],
      unknownKeyCount: 1,
      unmappedCount: 1,
    });
  });

  test('a dry run reads what it would send, with no cycle', async () => {
    await queued(true);
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({
      status: 'done',
      dryRun: true,
      runKey: null,
      resultCount: 2,
    });
    expect(zephyr.requests).toEqual([]);
  });

  test('an upload that ended without an answer reads as an unknown outcome', async () => {
    zephyr.upload = () => json({ message: 'down' }, 503);
    await queued();
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({
      status: 'failed',
      outcomeUnknown: true,
      error: expect.stringMatching(/^Outcome unknown/),
      runKey: null,
    });
  });

  test('a refused sync reads that and not an unknown outcome', async () => {
    zephyr.upload = () => json({ message: 'bad' }, 422);
    await queued();
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({ status: 'failed', outcomeUnknown: false });
  });

  test('a skipped sync reads its reason', async () => {
    await seedRun();
    await bind();
    await runTestManagementSync(db, RUN_ID);
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({ status: 'skipped', error: SKIP_CATALOG_NOT_READ });
  });

  test('the latest sync is the one read', async () => {
    zephyr.upload = () => json({ message: 'bad' }, 422);
    await queued();
    const [first] = await syncRows();
    await db
      .insert(schema.integrationActions)
      .values({ ...first!, id: undefined, status: 'pending', dedupeKey: 'later' } as never);
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({ status: 'pending' });
  });

  test('takes project:read: a reader sees it, a caller with no grant on the project does not', async () => {
    await queued();
    state.caller = as(4, InstanceRole.MEMBER, { projectId: 10, role: ProjectRole.VIEWER });
    expect((await readSync(at(RUN_ID))).sync).toMatchObject({ status: 'done' });
    state.caller = as(5, InstanceRole.MEMBER);
    expect([403, 404]).toContain((await refusal(readSync(at(RUN_ID)))).statusCode);
  });

  test('a missing run is a 404', async () => {
    expect((await refusal(readSync(at(999)))).statusCode).toBe(404);
  });
});

describe('Sync again in the demo', () => {
  test('sends the failed sync as done and links the canned cycle', async () => {
    await seedRun();
    await fillCatalog();
    await bind();
    zephyr.upload = () => json({ message: 'down' }, 503);
    await runTestManagementSync(db, RUN_ID);
    reset();
    expect(await sendDemoRunSync(db as never, RUN_ID)).toMatchObject({
      status: 'done',
      result: { runKey: `SHOP-R${RUN_ID}`, sent: 2 },
    });
    expect((await syncRow()).status).toBe('done');
    expect(await testRunLinks()).toMatchObject([{ key: `SHOP-R${RUN_ID}`, provider: 'zephyr-scale' }]);
    expect(zephyr.requests).toEqual([]);
  });

  test('a run with no failed sync is a 409', async () => {
    await seedRun();
    expect((await refusal(sendDemoRunSync(db as never, RUN_ID))).statusCode).toBe(409);
  });
});
