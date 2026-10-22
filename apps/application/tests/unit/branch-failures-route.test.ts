import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * `GET /api/projects/:id/branch-failures` with its `ETag`: the same data is a 304 without a body, and a run, a result,
 * what a failure shows that changes once stored, another branch or baseline, or another server version is a new
 * `ETag`. Access is checked before either answer.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
// Signed in as `state.caller`, held to the permission the route declares.
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  node: { req: { headers: Record<string, string> }; res: Record<string, unknown> };
}

let appVersion = '1.0.0';
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('useRuntimeConfig', () => ({ public: { appVersion } }));

const route = (await import('../../server/api/projects/[id]/branch-failures.get')).default as unknown as (
  event: FakeEvent,
) => Promise<{ failures: Array<{ executionId: number }> } | null>;
const { getBranchFailures } = await import('../../server/utils/branch-failures');

/** The route's answer to a request for project `projectId` with this query, naming `etag` in `If-None-Match`. */
async function ask(query: Record<string, string>, etag?: string, projectId = 1) {
  const written: Record<string, string> = {};
  const res = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader: (name: string, value: string) => (written[name.toLowerCase()] = value),
    getHeader: (name: string) => written[name.toLowerCase()],
  };
  const event: FakeEvent = {
    context: {},
    params: { id: String(projectId) },
    query,
    node: { req: { headers: etag ? { 'if-none-match': etag } : {} }, res },
  };
  const body = await route(event);
  return { status: res.statusCode, etag: written['etag']!, cacheControl: written['cache-control'], body };
}

const onProject = (projectId: number): RouteCaller => ({
  user: { id: 3, role: 'user', name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId, role: ProjectRole.VIEWER }]),
});

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = onProject(1);
  appVersion = '1.0.0';
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', branch: 'main', startTime: new Date(1000_000), totalTests: 2 },
    { id: 2, projectId: 1, status: 'failed', branch: 'feature/pay', startTime: new Date(2000_000), totalTests: 2 },
  ]);
  await db.insert(schema.testRunsCases).values([
    { id: 10, testRunId: 1, testCaseId: 1, status: 'failed', error: 'Error: expected 200', line: 7 },
    { id: 11, testRunId: 1, testCaseId: 2, status: 'passed', line: 3 },
    { id: 20, testRunId: 2, testCaseId: 1, status: 'failed', error: 'Error: expected 200', line: 7 },
  ]);
  await db
    .insert(schema.files)
    .values({ id: 1, testRunId: 1, testRunsCaseId: 10, type: 'trace', path: 'traces/10.zip' });
});

afterEach(async () => {
  await close();
});

describe('GET /api/projects/:id/branch-failures', () => {
  test('answers the failures with an ETag, and an empty 304 to a request that names it', async () => {
    const first = await ask({ branch: 'main' });
    expect(first.status).toBe(200);
    expect(first.etag).toMatch(/^"[\w-]+"$/);
    expect(first.cacheControl).toBe('private, no-cache');
    expect(first.body).toEqual(await getBranchFailures(db as never, 1, 'main', { overlays: false }));
    expect(first.body?.failures.map((f) => f.executionId)).toEqual([10]);

    const again = await ask({ branch: 'main' }, first.etag);
    expect(again).toMatchObject({ status: 304, etag: first.etag, body: null });
    // Another ETag is answered in full.
    expect(await ask({ branch: 'main' }, '"other"')).toMatchObject({ status: 200, etag: first.etag });
  });

  test('another branch or baseline is another ETag', async () => {
    const queries = [
      {},
      { branch: 'main' },
      { branch: 'feature/pay' },
      { branch: 'main', overlays: '1' },
      { run: '1' },
      { branch: 'main', origin: 'local' },
    ];
    const etags = await Promise.all(queries.map(async (query) => (await ask(query)).etag));
    expect(new Set(etags).size).toBe(queries.length);
    // The same request, spelled another way, is the same ETag.
    expect((await ask({ branch: ' main ', overlays: 'true' })).etag).toBe(etags[3]);
  });

  test('a new run on the branch, or one laid over the baseline, is a new ETag', async () => {
    const { etag } = await ask({ branch: 'main', overlays: '1' });
    await db.insert(schema.testRuns).values({
      id: 3,
      projectId: 1,
      status: 'passed',
      branch: 'main',
      origin: 'editor',
      isFullRun: 0,
      startTime: new Date(3000_000),
      totalTests: 1,
    });
    await db.insert(schema.testRunsCases).values({ id: 30, testRunId: 3, testCaseId: 1, status: 'passed', line: 7 });
    const laid = await ask({ branch: 'main', overlays: '1' }, etag);
    expect(laid.status).toBe(200);
    expect(laid.etag).not.toBe(etag);

    const { etag: before } = await ask({ branch: 'main' });
    await db.insert(schema.testRuns).values({
      id: 4,
      projectId: 1,
      status: 'passed',
      branch: 'main',
      startTime: new Date(4000_000),
      totalTests: 2,
    });
    const newer = await ask({ branch: 'main' }, before);
    expect(newer.status).toBe(200);
    expect(newer.etag).not.toBe(before);
  });

  test('a result stored in a run since, such as another repetition of a test, is a new ETag', async () => {
    const { etag } = await ask({ branch: 'main' });
    await db
      .insert(schema.testRunsCases)
      .values({ id: 12, testRunId: 1, testCaseId: 1, repeatEachIndex: 1, status: 'passed', line: 7 });
    const repeated = await ask({ branch: 'main' }, etag);
    expect(repeated.status).toBe(200);
    expect(repeated.etag).not.toBe(etag);
    expect((await ask({ branch: 'main' }, repeated.etag)).status).toBe(304);
  });

  test('what a failure shows that changes once stored is a new ETag each time', async () => {
    const changes: Array<() => Promise<unknown>> = [
      async () => {
        await db.insert(schema.failureClusters).values({
          id: 5,
          projectId: 1,
          fingerprint: 'fp',
          signature: 'expected 200',
          firstSeenRunId: 1,
          lastSeenRunId: 1,
        });
        await db.update(schema.testRunsCases).set({ failureClusterId: 5 }).where(eq(schema.testRunsCases.id, 10));
      },
      () =>
        db
          .update(schema.failureClusters)
          .set({ title: 'Checkout answers 500' })
          .where(eq(schema.failureClusters.id, 5)),
      () => db.update(schema.testRunsCases).set({ isNewRegression: 1 }).where(eq(schema.testRunsCases.id, 10)),
      () => db.update(schema.testCases).set({ owner: '@payments' }).where(eq(schema.testCases.id, 1)),
      () =>
        db
          .insert(schema.files)
          .values({ id: 2, testRunId: 1, testRunsCaseId: 10, type: 'screenshot', path: 'shots/10.png' }),
      () => db.delete(schema.files).where(eq(schema.files.id, 1)),
    ];
    let { etag } = await ask({ branch: 'main' });
    for (const change of changes) {
      await change();
      const next = await ask({ branch: 'main' }, etag);
      expect(next.status).toBe(200);
      expect(next.etag).not.toBe(etag);
      etag = next.etag;
    }
    const [failure] = (await ask({ branch: 'main' })).body!.failures as Array<Record<string, unknown>>;
    expect(failure).toMatchObject({
      clusterId: 5,
      clusterTitle: 'Checkout answers 500',
      isNew: true,
      owner: '@payments',
      traces: [],
      screenshot: 'shots/10.png',
    });
  });

  test('an execution a merge moves to another test is a new ETag, failed or not', async () => {
    await db.insert(schema.testCases).values({ id: 3, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds' });
    let { etag } = await ask({ branch: 'main' });
    for (const id of [11, 10]) {
      await db.update(schema.testRunsCases).set({ testCaseId: 3 }).where(eq(schema.testRunsCases.id, id));
      const next = await ask({ branch: 'main' }, etag);
      expect(next.status).toBe(200);
      expect(next.etag).not.toBe(etag);
      etag = next.etag;
    }
  });

  test('another version of the server is a new ETag', async () => {
    const { etag } = await ask({ branch: 'main' });
    appVersion = '1.1.0';
    expect((await ask({ branch: 'main' }, etag)).status).toBe(200);
  });

  test('a caller without access to the project is refused, whatever ETag it names', async () => {
    const { etag } = await ask({ branch: 'main' });
    state.caller = onProject(2);
    await expect(ask({ branch: 'main' }, etag)).rejects.toMatchObject({ statusCode: 403 });
    state.caller = null;
    await expect(ask({ branch: 'main' }, etag)).rejects.toMatchObject({ statusCode: 401 });
  });

  test('a chosen run the project does not hold is refused, whatever ETag it names', async () => {
    const { etag } = await ask({ run: '1' });
    await expect(ask({ run: '99' }, etag)).rejects.toMatchObject({ statusCode: 404 });
    await expect(ask({ run: 'x' }, etag)).rejects.toMatchObject({ statusCode: 400 });
  });
});
