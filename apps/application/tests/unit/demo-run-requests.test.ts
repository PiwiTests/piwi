import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Run on my machine in the demo: the requester's seeded app answers a request as it is read, and a request it ran
 * links its run, private to the requester, whose tests pass; a request stopped before its run started has none.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));
vi.mock('#shared/handlers/capabilities', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isOptInCapabilityOn: async () => true,
}));

const { apiCreateRunRequest, apiGetRunRequest, apiStopRunRequest, demoReadRunRequestBody } =
  await import('~~/app/demo/api/run-requests');
const { buildAccessSummary, InstanceRole, ProjectRole } = await import('#shared/permissions');

const REQUESTER = 7;
const access = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.CONTRIBUTOR }]);
const start = new Date('2026-11-11T10:00:00Z');

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.runTargets).values({ userId: REQUESTER, apiKeyId: 1, kind: 'desktop', deviceName: 'Laptop' });
  await db.insert(schema.testRuns).values({
    id: 5,
    projectId: 1,
    status: 'failed',
    startTime: new Date('2026-11-10T09:00:00Z'),
    branch: 'main',
    totalTests: 1,
    failedTests: 1,
  });
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, title: 'keeps the basket', filePath: 'cart.spec.ts' });
  await db
    .insert(schema.testRunsCases)
    .values({ id: 50, testRunId: 5, testCaseId: 1, status: 'failed', line: 3, browserName: 'chromium' });
});

afterEach(() => vi.useRealTimers());
afterAll(() => close());

async function requestAt(at: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  const input = await demoReadRunRequestBody({ source: { runId: 5, tests: 'failed' }, options: {} }, REQUESTER);
  return apiCreateRunRequest(REQUESTER, input);
}

async function readAt(id: string, at: Date) {
  vi.setSystemTime(at);
  return apiGetRunRequest(id, REQUESTER, access);
}

const after = (ms: number) => new Date(start.getTime() + ms);

describe('the demo app answering a run request', () => {
  test('a request it ran links its run, private to the requester, whose tests pass', async () => {
    const created = await requestAt(start);
    expect(created.runId).toBeNull();
    expect((await readAt(created.id, after(5_000))).runId).toBeNull();

    const running = await readAt(created.id, after(8_000));
    expect(running.state).toBe('running');
    expect(running.runId).toEqual(expect.any(Number));
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, running.runId!));
    expect(run).toMatchObject({ status: 'running', origin: 'request', requesterId: REQUESTER, branch: 'main' });

    const ended = await readAt(created.id, after(16_000));
    expect(ended).toMatchObject({ state: 'ended', outcome: 'passed', runId: running.runId });
    const [done] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, running.runId!));
    expect(done).toMatchObject({ status: 'passed', totalTests: 1, passedTests: 1 });
    const executions = await db
      .select()
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, running.runId!));
    expect(executions).toEqual([
      expect.objectContaining({ testCaseId: 1, status: 'passed', line: 3, browserName: 'chromium' }),
    ]);
  });

  test('a request first read once it ended still gets its run', async () => {
    const created = await requestAt(after(60_000));
    const ended = await readAt(created.id, after(120_000));
    expect(ended).toMatchObject({ state: 'ended', outcome: 'passed', runId: expect.any(Number) });
  });

  test('a run stopped while its tests ran ends interrupted; a request stopped before it ran has no run', async () => {
    const ran = await requestAt(after(200_000));
    await readAt(ran.id, after(208_000));
    await apiStopRunRequest(ran.id, REQUESTER, access);
    const stopped = await readAt(ran.id, after(211_000));
    expect(stopped).toMatchObject({ state: 'ended', outcome: 'stopped', runId: expect.any(Number) });
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, stopped.runId!));
    expect(run!.status).toBe('interrupted');

    const early = await requestAt(after(300_000));
    await readAt(early.id, after(303_000));
    await apiStopRunRequest(early.id, REQUESTER, access);
    expect(await readAt(early.id, after(320_000))).toMatchObject({ state: 'ended', outcome: 'stopped', runId: null });
  });
});
