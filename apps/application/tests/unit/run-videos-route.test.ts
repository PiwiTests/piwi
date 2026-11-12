import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState, type RouteCaller } from './route-access';

/** `GET /api/test-runs/:id/videos`: a run's final attempts with their videos, for a caller who may read the run. */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('apiError', apiError);

const route = (await import('../../server/api/test-runs/[id]/videos.get')).default as unknown as (
  event: FakeEvent,
) => Promise<{
  executions: Array<{
    executionId: number;
    title: string;
    retries: number;
    createPageEndMs: number | null;
    video: { path: string; contentType: string } | null;
  }>;
  videoCount: number;
  truncated: boolean;
}>;

const ask = (runId: string) => route({ context: {}, params: { id: runId } });

const onProject = (projectId: number): RouteCaller => ({
  user: { id: 3, role: 'user', name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId, role: ProjectRole.VIEWER }]),
});

const T0 = 1_700_000_000_000;

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = onProject(1);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds' },
    { id: 3, projectId: 2, filePath: 'tests/other.spec.ts', title: 'other' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', startTime: new Date(T0), totalTests: 2 },
    { id: 2, projectId: 1, status: 'passed', startTime: new Date(T0), totalTests: 1 },
    { id: 3, projectId: 2, status: 'passed', startTime: new Date(T0), totalTests: 1 },
  ]);
});

afterEach(async () => {
  await close();
});

describe('GET /api/test-runs/:id/videos', () => {
  test('lists the final attempts with their videos and where Create page ended', async () => {
    await db.insert(schema.testRunsCases).values([
      // The first attempt of a test that was retried: not listed.
      { id: 10, testRunId: 1, testCaseId: 1, status: 'failed', retries: 0, finalAttempt: false, startedAt: T0 },
      {
        id: 11,
        testRunId: 1,
        testCaseId: 1,
        status: 'passed',
        retries: 1,
        passedAfterFailure: true,
        startedAt: T0 + 5000,
        duration: 1200,
        parallelIndex: 1,
        steps: [{ title: 'Create page', startTime: T0 + 5100, duration: 30, category: 'pw:api' }],
      },
      {
        id: 12,
        testRunId: 1,
        testCaseId: 2,
        status: 'failed',
        startedAt: T0,
        duration: 800,
        parallelIndex: 0,
        line: 4,
      },
    ]);
    await db.insert(schema.files).values([
      {
        id: 1,
        testRunId: 1,
        testRunsCaseId: 10,
        type: 'attachment',
        subtype: 'video',
        label: 'video/webm',
        path: 'old.webm',
      },
      {
        id: 2,
        testRunId: 1,
        testRunsCaseId: 11,
        type: 'attachment',
        subtype: 'video',
        label: 'video/webm',
        path: 'p/11.webm',
        size: 40,
      },
      {
        id: 3,
        testRunId: 1,
        testRunsCaseId: 11,
        type: 'attachment',
        subtype: 'screenshot',
        label: 'image/png',
        path: 'p/11.png',
      },
    ]);

    const answer = await ask('1');
    // By file: cart before checkout.
    expect(answer.executions.map((e) => [e.executionId, e.title])).toEqual([
      [12, 'adds'],
      [11, 'pays'],
    ]);
    expect(answer.executions[1]).toMatchObject({
      retries: 1,
      createPageEndMs: T0 + 5130,
      video: { path: 'p/11.webm', contentType: 'video/webm' },
    });
    expect(answer.executions[0]).toMatchObject({ video: null, createPageEndMs: null });
    expect(answer.videoCount).toBe(1);
    expect(answer.truncated).toBe(false);
  });

  test('is empty for a run with no videos', async () => {
    await db.insert(schema.testRunsCases).values({ id: 20, testRunId: 2, testCaseId: 1, status: 'passed' });
    expect(await ask('2')).toMatchObject({ videoCount: 0, truncated: false });
    expect((await ask('2')).executions.every((e) => e.video === null)).toBe(true);
  });

  test('is empty for a run with no executions', async () => {
    expect(await ask('1')).toEqual({ executions: [], videoCount: 0, truncated: false });
  });

  test('is refused to a caller with no access to the run’s project', async () => {
    state.caller = onProject(2);
    await expect(ask('1')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('is refused without a sign-in, and for a run that does not exist', async () => {
    state.caller = null;
    await expect(ask('1')).rejects.toMatchObject({ statusCode: 401 });
    state.caller = onProject(1);
    await expect(ask('999')).rejects.toMatchObject({ statusCode: 404 });
    await expect(ask('abc')).rejects.toMatchObject({ statusCode: 400 });
  });
});
