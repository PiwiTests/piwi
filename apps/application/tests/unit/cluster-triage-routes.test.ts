import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

/** The triage routes of one cluster refuse a malformed body with a 400, not a server error. */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Handler = (event: FakeEvent) => Promise<unknown>;
const patchStatus = underRoutePermission(
  state,
  (await import('../../server/api/failure-clusters/[id]/status.patch')).default as unknown as Handler,
);
const extractCases = underRoutePermission(
  state,
  (await import('../../server/api/failure-clusters/[id]/extract-cases.post')).default as unknown as Handler,
);

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = {
    user: { id: 2, role: InstanceRole.MEMBER, name: 'Robin', username: 'robin' } as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]),
  };
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'Error: broken',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    triageNote: 'Looking into it',
  });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'pays' });
  await db.insert(schema.testRunsCases).values({ testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 1 });
});

afterEach(async () => {
  await close();
});

const note = async () =>
  (
    await db
      .select({ triageNote: schema.failureClusters.triageNote })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, 1))
  )[0]?.triageNote;

describe('PATCH /api/failure-clusters/:id/status', () => {
  test('refuses a note that is neither a string nor null, and an unknown status', async () => {
    await expect(
      patchStatus({ params: { id: '1' }, body: { status: 'resolved', triageNote: 42 } }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(patchStatus({ params: { id: '1' }, body: { status: 'closed' } })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await note()).toBe('Looking into it');
  });

  test('keeps the note when none is sent, and replaces it with the one sent', async () => {
    await patchStatus({ params: { id: '1' }, body: { status: 'resolved' } });
    expect(await note()).toBe('Looking into it');
    await patchStatus({ params: { id: '1' }, body: { status: 'open', triageNote: 'Back again' } });
    expect(await note()).toBe('Back again');
  });
});

describe('POST /api/failure-clusters/:id/extract-cases', () => {
  test('refuses a note that is not a string', async () => {
    await expect(
      extractCases({ params: { id: '1' }, body: { testCaseIds: [1], triageNote: { text: 'x' } } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
