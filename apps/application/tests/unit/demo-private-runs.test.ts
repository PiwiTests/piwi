import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { InstanceRole } from '#shared/permissions';
import { DEMO_GROUPS, DEMO_USERS } from '~~/app/demo/demo-users';

/**
 * A requested run in the demo is its requester's alone, as on the server: another persona, an administrator
 * included, is answered 404 on the run, on its executions and on what hangs off them.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { handleDemoRequest } = await import('~~/app/demo/api/router');

/** An administrator. */
const AVERY = 1;
/** A maintainer of every project, through the QA group. */
const JORDAN = 7;

/** Avery's private run and its execution; Jordan's private run and its execution. */
const AVERY_RUN = 10;
const AVERY_EXECUTION = 100;
const JORDAN_RUN = 11;
const JORDAN_EXECUTION = 110;

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values([1, 2, 3, 4].map((id) => ({ id, name: `project-${id}` })));
  await db
    .insert(schema.users)
    .values(
      DEMO_USERS.map((u) => ({ id: u.id, username: u.username, password: '', role: u.instanceRole, name: u.name })),
    );
  await db
    .insert(schema.groups)
    .values(DEMO_GROUPS.map((g) => ({ id: g.id, name: g.name, description: g.description })));
  await db
    .insert(schema.groupMembers)
    .values(DEMO_GROUPS.flatMap((g) => g.memberIds.map((userId) => ({ groupId: g.id, userId }))));
  await db
    .insert(schema.roleBindings)
    .values([
      ...DEMO_GROUPS.flatMap((g) => g.bindings.map((b) => ({ groupId: g.id, projectId: b.projectId, role: b.role }))),
      ...DEMO_USERS.filter((u) => u.instanceRole !== InstanceRole.ADMINISTRATOR).flatMap((u) =>
        u.bindings.map((b) => ({ userId: u.id, projectId: b.projectId, role: b.role })),
      ),
    ]);
  const startTime = new Date('2026-11-11T10:00:00Z');
  await db.insert(schema.testRuns).values([
    { id: AVERY_RUN, projectId: 1, status: 'passed', startTime, origin: 'request', requesterId: AVERY },
    { id: JORDAN_RUN, projectId: 1, status: 'passed', startTime, origin: 'request', requesterId: JORDAN },
  ]);
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, title: 'keeps the basket', filePath: 'cart.spec.ts' });
  await db.insert(schema.testRunsCases).values([
    { id: AVERY_EXECUTION, testRunId: AVERY_RUN, testCaseId: 1, status: 'passed' },
    { id: JORDAN_EXECUTION, testRunId: JORDAN_RUN, testCaseId: 1, status: 'passed' },
  ]);
});

afterAll(() => close());

const get = (userId: number, path: string, query?: string) =>
  handleDemoRequest(path, 'GET', undefined, query, userId) as Promise<any>;

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

describe("a requester's private run in the demo", () => {
  test('its requester sees it and its execution', async () => {
    expect(await get(JORDAN, `/api/test-runs/${JORDAN_RUN}`)).toMatchObject({ id: JORDAN_RUN });
    expect(await status(get(JORDAN, `/api/test-run-cases/${JORDAN_EXECUTION}`))).toBe(200);
    expect(await get(AVERY, `/api/test-runs/${AVERY_RUN}`)).toMatchObject({ id: AVERY_RUN });
    expect(await status(get(AVERY, `/api/test-run-cases/${AVERY_EXECUTION}`))).toBe(200);
  });

  test('a maintainer of its project is answered 404 on the run, its coverage and its execution', async () => {
    expect(await status(get(JORDAN, `/api/test-runs/${AVERY_RUN}`))).toBe(404);
    expect(await status(get(JORDAN, `/api/test-runs/${AVERY_RUN}/coverage`))).toBe(404);
    expect(await status(get(JORDAN, `/api/test-run-cases/${AVERY_EXECUTION}`))).toBe(404);
    expect(await status(get(JORDAN, '/api/links', `entityType=test_run&entityId=${AVERY_RUN}`))).toBe(404);
  });

  test('an administrator is answered 404 on the run and its execution', async () => {
    expect(await status(get(AVERY, `/api/test-runs/${JORDAN_RUN}`))).toBe(404);
    expect(await status(get(AVERY, `/api/test-run-cases/${JORDAN_EXECUTION}`))).toBe(404);
    expect(await status(get(AVERY, '/api/links', `entityType=test_runs_case&entityId=${JORDAN_EXECUTION}`))).toBe(404);
  });
});
