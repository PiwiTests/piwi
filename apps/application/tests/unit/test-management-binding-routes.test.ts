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
 * A project's test management binding through its routes, against a stubbed Zephyr: saved and read without the token
 * ever coming back, refused with a 400 where its fields are wrong, kept apart from the tracker binding, and offered
 * its pickers and stored catalog without a call to Zephyr where the route says it reads the database only.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';
// The pickers share the connection's request limiter; this fast rate keeps the stubbed calls from waiting on it.
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
/** The headers the route set on its answer. */
const headers: Record<string, string | number> = {};
vi.stubGlobal('setResponseHeader', (_event: FakeEvent, name: string, value: string | number) => {
  headers[name] = value;
});

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.binding-payload.binding-signature';
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/zephyr-scale/${name}.json`, import.meta.url), 'utf8'));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Every request sent to Zephyr, as its path, and what the next answers should be. */
const sent: string[] = [];
let unauthorized = false;
/** The `Retry-After` of a 429 the stubbed Zephyr answers with, or null for no 429. */
let rateLimited: string | null = null;
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    sent.push(url.pathname + url.search);
    if (unauthorized) return json(fixture('error-unauthorized'), 401);
    if (rateLimited !== null) {
      return new Response('', { status: 429, headers: rateLimited ? { 'Retry-After': rateLimited } : {} });
    }
    if (url.pathname.endsWith('/projects')) return json(fixture('projects-page-2'));
    if (url.pathname.endsWith('/statuses')) return json(fixture('statuses-test-execution'));
    if (url.pathname.endsWith('/folders')) return json(fixture('folders-test-cycle'));
    return json({ message: 'unexpected' }, 404);
  }),
);

type Route = (event: FakeEvent) => Promise<any>;
const route = (module: { default: unknown }) => underRoutePermission(state, module.default as Route);
const getBinding = route(await import('../../server/api/projects/[id]/test-management/index.get'));
const putBinding = route(await import('../../server/api/projects/[id]/test-management/index.put'));
const getOptions = route(await import('../../server/api/projects/[id]/test-management/options.get'));
const getCases = route(await import('../../server/api/projects/[id]/test-management/cases.get'));
const getKeyConfig = route(await import('../../server/api/projects/[id]/test-management/key-config.get'));
const getSummary = route(await import('../../server/api/projects/[id]/test-management/summary.get'));
const create = route(await import('../../server/api/integrations/connections/index.post'));
const putTracker = route(await import('../../server/api/projects/[id]/integrations.put'));
const { boundConnectionId } = await import('../../server/utils/integrations/bound-connection');
const { testManagementOptionsCache } = await import('../../server/utils/integrations/picker-cache');
const { connectionPausedUntil } = await import('../../server/utils/integrations/actions');

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

const at = (id: number, body?: unknown, query: Record<string, string> = {}): FakeEvent => ({
  params: { id: String(id) },
  query,
  body,
});

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
let jiraId: number;

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
  ).connection.id;
  jiraId = (
    await create({
      params: {},
      query: {},
      body: {
        provider: 'jira',
        name: 'Jira',
        baseUrl: 'https://example.atlassian.net',
        credentials: { email: 'ci@example.com', apiToken: 'jira-token' },
      },
    })
  ).connection.id;
});
afterAll(async () => {
  await close();
  vi.unstubAllGlobals();
  delete process.env.PIWI_SECRET_KEY;
  delete process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE;
});
beforeEach(async () => {
  state.caller = projectAdmin;
  sent.length = 0;
  unauthorized = false;
  rateLimited = null;
  for (const name of Object.keys(headers)) delete headers[name];
  for (const id of [zephyrId, jiraId]) connectionPausedUntil(id, new Date(Date.now() + 1e10));
  testManagementOptionsCache.deleteWhere(() => true);
  await db.delete(schema.projectTestManagement);
  await db.delete(schema.projectIntegrations);
  await db.delete(schema.testManagementCases);
  await db.delete(schema.testManagementCatalogReads);
  await db.update(schema.integrationConnections).set({ status: 'unverified', lastError: null });
});

const valid = () => ({ connectionId: zephyrId, providerProjectKey: 'WEB_APP' });

describe('GET and PUT the binding', () => {
  test('a project with no binding reads as the defaults, with the connections it may use and no token', async () => {
    const answer = await getBinding(at(10));
    expect(answer.binding).toMatchObject({ connectionId: null, dryRun: true, enabled: true });
    expect(answer.connections).toEqual([
      { id: zephyrId, provider: 'zephyr-scale', name: 'Zephyr', status: 'unverified' },
    ]);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  test('saves a binding with dry run on, and reads it back', async () => {
    const saved = await putBinding(at(10, valid()));
    expect(saved.binding).toMatchObject({ connectionId: zephyrId, providerProjectKey: 'WEB_APP', dryRun: true });
    expect((await getBinding(at(10))).binding).toEqual(saved.binding);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(await db.select().from(schema.projectTestManagement)).toHaveLength(1);
  });

  test('saving again replaces the one row, and a null connection clears it', async () => {
    await putBinding(at(10, valid()));
    await putBinding(at(10, { ...valid(), dryRun: false, keySources: { tags: false, externalId: true } }));
    const rows = await db.select().from(schema.projectTestManagement);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dryRun: false, keySources: { tags: false, externalId: true } });
    expect((await putBinding(at(10, { connectionId: null }))).binding.connectionId).toBeNull();
    expect(await db.select().from(schema.projectTestManagement)).toEqual([]);
  });

  test.each([
    ['not an object', 'x', 'Invalid request body'],
    ['a connection that is not a number', { connectionId: 'a', providerProjectKey: 'WEB_APP' }, 'Invalid connection'],
    ['an unknown connection', { connectionId: 9999, providerProjectKey: 'WEB_APP' }, 'Connection not found'],
    ['no project key', { connectionId: 1 }, 'Choose a project'],
    ['a key that is not a project key', { connectionId: 1, providerProjectKey: 'web app;' }, 'Choose a project'],
    [
      'a name without {runId}',
      { connectionId: 1, providerProjectKey: 'WEB_APP', runPolicy: { nameTemplate: 'Nightly' } },
      '{runId}',
    ],
    [
      'an unknown variable',
      { connectionId: 1, providerProjectKey: 'WEB_APP', runPolicy: { nameTemplate: '{runId} {nope}' } },
      '{nope} is not a variable',
    ],
    [
      'a status name that is too long',
      { connectionId: 1, providerProjectKey: 'WEB_APP', statuses: { pass: 'x'.repeat(256) } },
      '255 characters',
    ],
    [
      'flaky as a status with none named',
      { connectionId: 1, providerProjectKey: 'WEB_APP', options: { flakyAs: 'flaky' } },
      'Name the status',
    ],
    [
      'an unknown flaky handling',
      { connectionId: 1, providerProjectKey: 'WEB_APP', options: { flakyAs: 'maybe' } },
      'Invalid flaky handling',
    ],
  ])('answers 400 for %s and stores nothing', async (_name, body, message) => {
    const sentBody =
      typeof body === 'object' && body && (body as { connectionId?: number }).connectionId === 1
        ? { ...body, connectionId: zephyrId }
        : body;
    expect(await refusal(putBinding(at(10, sentBody)))).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    });
    expect(await db.select().from(schema.projectTestManagement)).toEqual([]);
  });

  test('refuses a Jira connection', async () => {
    expect(await refusal(putBinding(at(10, { connectionId: jiraId, providerProjectKey: 'WEB_APP' })))).toEqual({
      statusCode: 400,
      message: 'A test management binding uses a test management connection only',
    });
  });

  test('is for project admins: a contributor is refused on both verbs', async () => {
    state.caller = contributor;
    expect(await refusal(getBinding(at(10)))).toMatchObject({ statusCode: 403 });
    expect(await refusal(putBinding(at(10, valid())))).toMatchObject({ statusCode: 403 });
  });
});

describe('the two bindings of a project are kept apart', () => {
  const tracker = () => ({ connectionId: jiraId, projectKey: 'WEB', issueType: 'Bug' });

  test('saving the tracker binding leaves the test management binding in place', async () => {
    await putBinding(at(10, valid()));
    await putTracker(at(10, tracker()));
    expect((await getBinding(at(10))).binding).toMatchObject({ connectionId: zephyrId, providerProjectKey: 'WEB_APP' });
    expect(await db.select().from(schema.projectIntegrations)).toHaveLength(1);
  });

  test('saving the test management binding leaves the tracker binding in place', async () => {
    await putTracker(at(10, tracker()));
    await putBinding(at(10, valid()));
    await putBinding(at(10, { connectionId: null }));
    const [row] = await db.select().from(schema.projectIntegrations);
    expect(row).toMatchObject({ projectId: 10, connectionId: jiraId });
  });

  test('boundConnectionId answers each kind from its own binding', async () => {
    expect(await boundConnectionId(db, 10, 'test-management')).toBeNull();
    await putTracker(at(10, tracker()));
    expect(await boundConnectionId(db, 10, 'tracker')).toBe(jiraId);
    expect(await boundConnectionId(db, 10, 'test-management')).toBeNull();
    await putBinding(at(10, { ...valid(), enabled: false }));
    expect(await boundConnectionId(db, 10, 'test-management')).toBe(zephyrId);
    expect(await boundConnectionId(db, 10, 'tracker')).toBe(jiraId);
    expect(await boundConnectionId(db, 10, 'wiki')).toBeNull();
    expect(await boundConnectionId(db, null, 'test-management')).toBeNull();
  });
});

describe('GET options', () => {
  test('lists the projects and, for a project key, its statuses and folders by path; never the token', async () => {
    const answer = await getOptions(at(10, undefined, { connectionId: String(zephyrId), projectKey: 'WEB_APP' }));
    expect(answer.projects).toEqual([{ key: 'WEB_APP', enabled: true }]);
    expect(answer.statuses.map((s: { name: string }) => s.name)).toEqual([
      'Not Executed',
      'In Progress',
      'Pass',
      'Fail',
    ]);
    expect(answer.folders).toEqual([
      { id: '40001', path: 'Nightly' },
      { id: '40002', path: 'Nightly / Release 4.2' },
    ]);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  test('answers from the cache the second time', async () => {
    const query = { connectionId: String(zephyrId) };
    await getOptions(at(10, undefined, query));
    const calls = sent.length;
    await getOptions(at(10, undefined, query));
    expect(sent).toHaveLength(calls);
  });

  test('a 401 marks the connection failed and answers 502, not a 401 that would sign the person out', async () => {
    unauthorized = true;
    expect(await refusal(getOptions(at(10, undefined, { connectionId: String(zephyrId) })))).toMatchObject({
      statusCode: 502,
    });
    const [row] = await db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, zephyrId));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).not.toContain(TOKEN);
  });

  test('a 429 pauses the connection for the wait Zephyr named and answers 429 with that Retry-After', async () => {
    rateLimited = '30';
    const query = { connectionId: String(zephyrId) };
    expect(await refusal(getOptions(at(10, undefined, query)))).toMatchObject({ statusCode: 429 });
    expect(headers['Retry-After']).toBe(30);
    const until = connectionPausedUntil(zephyrId, new Date());
    expect(until!.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(until!.getTime() - Date.now()).toBeLessThanOrEqual(30_000);
  });

  test('a 429 that names no wait pauses the connection for a minute', async () => {
    rateLimited = '';
    await refusal(getOptions(at(10, undefined, { connectionId: String(zephyrId) })));
    expect(headers['Retry-After']).toBe(60);
    const until = connectionPausedUntil(zephyrId, new Date());
    expect(until!.getTime() - Date.now()).toBeGreaterThan(55_000);
  });

  test('during a pause the options answer 429 with Retry-After and make no call', async () => {
    rateLimited = '30';
    const query = { connectionId: String(zephyrId) };
    await refusal(getOptions(at(10, undefined, query)));
    const calls = sent.length;
    rateLimited = null;
    expect(await refusal(getOptions(at(10, undefined, query)))).toMatchObject({ statusCode: 429 });
    expect(sent).toHaveLength(calls);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
    expect(Number(headers['Retry-After'])).toBeLessThanOrEqual(30);
  });

  test('refuses a bad connection, a Jira connection and a bad key, before any call', async () => {
    for (const query of [{}, { connectionId: 'x' }, { connectionId: String(jiraId) }, { connectionId: '9999' }]) {
      await refusal(getOptions(at(10, undefined, query)));
    }
    expect(
      await refusal(getOptions(at(10, undefined, { connectionId: String(zephyrId), projectKey: 'a;b' }))),
    ).toMatchObject({
      statusCode: 400,
    });
    expect(sent).toEqual([]);
  });
});

describe('GET cases', () => {
  const catalog = async () => {
    const fetchedAt = new Date('2026-11-09T10:00:00Z');
    await db.insert(schema.testManagementCases).values([
      {
        connectionId: zephyrId,
        projectKey: 'WEB_APP',
        key: 'WEB_APP-T1',
        providerId: '1',
        name: 'Login works',
        statusName: 'Approved',
        fetchedAt,
      },
    ]);
  };

  test('answers from the stored catalog without calling Zephyr', async () => {
    await putBinding(at(10, valid()));
    await catalog();
    const answer = await getCases(at(10, undefined, { keys: 'WEB_APP-T1,WEB_APP-T999' }));
    expect(answer).toEqual({
      bound: true,
      projectKey: 'WEB_APP',
      fetchedAt: '2026-11-09T10:00:00.000Z',
      cases: { 'WEB_APP-T1': { name: 'Login works', status: 'Approved', url: null }, 'WEB_APP-T999': null },
    });
    expect(sent).toEqual([]);
  });

  test('a catalog never read has no fetchedAt', async () => {
    await putBinding(at(10, valid()));
    expect((await getCases(at(10, undefined, { keys: 'WEB_APP-T1' }))).fetchedAt).toBeNull();
  });

  test('a catalog read that found no cases has a fetchedAt, and every key is unknown', async () => {
    await putBinding(at(10, valid()));
    await db
      .insert(schema.testManagementCatalogReads)
      .values({ connectionId: zephyrId, projectKey: 'WEB_APP', fetchedAt: new Date('2026-11-09T10:00:00Z') });
    expect(await getCases(at(10, undefined, { keys: 'WEB_APP-T1' }))).toMatchObject({
      fetchedAt: '2026-11-09T10:00:00.000Z',
      cases: { 'WEB_APP-T1': null },
    });
  });

  test('a project with no binding is not bound', async () => {
    expect(await getCases(at(10, undefined, { keys: 'WEB_APP-T1' }))).toMatchObject({ bound: false, cases: {} });
  });

  test('is readable by a contributor and refuses bad or too many keys', async () => {
    state.caller = contributor;
    await getCases(at(10, undefined, { keys: 'WEB_APP-T1' }));
    for (const keys of ['', 'no key', 'a-b,;drop', Array.from({ length: 101 }, (_, i) => `WEB_APP-T${i}`).join(',')]) {
      expect(await refusal(getCases(at(10, undefined, { keys })))).toMatchObject({ statusCode: 400 });
    }
  });
});

describe('GET summary', () => {
  const seedRun = async () => {
    await db.insert(schema.testCases).values({ id: 1, projectId: 10, filePath: 'a.spec.ts', title: 'logs in' });
    const [run] = await db
      .insert(schema.testRuns)
      .values({
        projectId: 10,
        status: 'passed',
        branch: 'main',
        environment: 'prod',
        startTime: new Date(),
        metadata: {},
      })
      .returning();
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: run!.id, testCaseId: 1, status: 'passed', tags: ['WEB_APP-T1'] });
    return run!.id;
  };

  afterEach(async () => {
    await db.delete(schema.testRunsCases);
    await db.delete(schema.testRuns);
    await db.delete(schema.testCases);
  });

  test('a project with no binding is not bound', async () => {
    expect(await getSummary(at(10))).toEqual({ bound: false });
  });

  test('maps the last complete run from the stored catalog without calling Zephyr', async () => {
    await putBinding(at(10, valid()));
    const runId = await seedRun();
    const answer = await getSummary(at(10));
    expect(answer).toMatchObject({
      bound: true,
      runId,
      summary: { mappedTests: 1, keys: ['WEB_APP-T1'], catalogRead: false, unknownKeys: [] },
    });
    expect(sent).toEqual([]);
  });

  test('needs project:manage: a contributor is refused', async () => {
    await putBinding(at(10, valid()));
    state.caller = contributor;
    expect(await refusal(getSummary(at(10)))).toMatchObject({ statusCode: 403 });
  });
});

describe('GET key-config', () => {
  test('a project with no binding is not bound', async () => {
    expect(await getKeyConfig(at(10))).toEqual({ bound: false });
  });

  test('reads the default pattern and the key sources, and nothing about the connection', async () => {
    await putBinding(at(10, { ...valid(), keySources: { tags: true, externalId: false } }));
    const answer = await getKeyConfig(at(10));
    expect(answer).toEqual({
      bound: true,
      projectKey: 'WEB_APP',
      pattern: '^WEB\\_APP-T[0-9]+$',
      keySources: { tags: true, externalId: false },
    });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(sent).toEqual([]);
  });

  test("uses the project's own test case pattern when it has one", async () => {
    await putBinding(at(10, valid()));
    await db
      .update(schema.projects)
      .set({ tagKeys: { issue: null, testCase: '^TC-[0-9]+$' } })
      .where(eq(schema.projects.id, 10));
    expect(await getKeyConfig(at(10))).toMatchObject({ pattern: '^TC-[0-9]+$' });
    await db.update(schema.projects).set({ tagKeys: null }).where(eq(schema.projects.id, 10));
  });

  test('is readable by a contributor', async () => {
    await putBinding(at(10, valid()));
    state.caller = contributor;
    expect(await getKeyConfig(at(10))).toMatchObject({ bound: true });
  });
});
