import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import type { H3Event } from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_AUTH_ENABLED = 'true';

type Db = ReturnType<typeof drizzle<typeof schema>>;
const state = vi.hoisted(() => ({ db: null as unknown, machineRuns: new Set<number>() }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('#shared/handlers/capabilities', () => ({
  isOptInCapabilityOn: async (_db: unknown, projectId: number) => state.machineRuns.has(projectId),
}));
// The feature-graph write runs after persistRunCases returns, off the request path: it has nothing to do here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});
vi.stubGlobal(
  'getRequestHeader',
  (event: { node: { req: { headers: Record<string, string> } } }, name: string) => event.node.req.headers[name],
);
vi.stubGlobal('getRouterParam', (event: { params?: Record<string, string> }, name: string) => event.params?.[name]);

const { generateApiKey } = await import('../../server/utils/auth');
const { answerRequest, claimRequest, moveRequestState, requireRunTarget, stopOwnRequest } =
  await import('../../server/utils/run-requests');
const { RUN_TOKEN_LIFETIME_MS, bindRunToRequest, grantedProject, spendRunToken } =
  await import('../../server/utils/run-tokens');
const { sanitizeMetadata } = await import('../../server/utils/sanitize');
const { resolveRunProjectId, resolveTestRunCaseProjectId } = await import('../../server/utils/project-access');
const { carryRequestOrigin, isLabRun, isVisibleRun, runOrigin, withRequestOrigin } =
  await import('#shared/run-eligibility');
const { getProjectLatestRun } = await import('#shared/handlers/test-runs');
const { deleteUserRecord } = await import('#shared/handlers/users');
const { getProject, listKeptRuns, listProjects } = await import('#shared/handlers/projects');
const { getActiveTestRuns, getRecentTestRuns, getTestRun } = await import('#shared/handlers/test-runs');
const { searchProjectsTestRunsCases } = await import('#shared/handlers/search');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { ADMIN_ACCESS } = await import('#shared/permissions');
const { getBranchFailures } = await import('../../server/utils/branch-failures');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

let db: Db;
let userId: number;
let otherUserId: number;
let projectId: number;
let otherProjectId: number;
let sourceRunId: number;

const T0 = new Date('2026-09-01T10:00:00Z');

function eventWith(headers: Record<string, string>): H3Event {
  return { context: {}, node: { req: { headers }, res: {} } } as unknown as H3Event;
}

function bearer(token: string | null): H3Event {
  return eventWith(token ? { authorization: `Bearer ${token}` } : {});
}

async function caller() {
  const made = generateApiKey();
  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      userId,
      name: 'Piwi Desktop on LAPTOP-42 (macOS)',
      keyHash: made.hash,
      keyPrefix: made.prefix,
      permissions: ['run:receive'],
    })
    .returning();
  await db
    .insert(schema.runTargets)
    .values({ userId, apiKeyId: key!.id, kind: 'desktop', deviceName: 'Piwi Desktop on LAPTOP-42 (macOS)' });
  return requireRunTarget(bearer(made.plaintext));
}

let nextId = 0;
async function request(values: Partial<typeof schema.runRequests.$inferInsert> = {}) {
  const id = (++nextId).toString(16).padStart(32, '0');
  await db.insert(schema.runRequests).values({
    id,
    projectId,
    requesterId: userId,
    kind: 'run',
    tests: [{ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' }],
    options: {},
    source: { runId: sourceRunId },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: T0,
    updatedAt: T0,
    ...values,
  });
  return id;
}

/** A request claimed and answered **Run**, with the run token the answer returned. */
async function ranRequest() {
  const c = await caller();
  const id = await request();
  await claimRequest(c, id);
  const answered = await answerRequest(c, id, { decision: 'run' });
  if (!answered.ok || !answered.runToken) throw new Error('Run gave no run token');
  return { c, id, token: answered.runToken };
}

async function stored(id: string) {
  const [row] = await db.select().from(schema.runRequests).where(eq(schema.runRequests.id, id));
  return row!;
}

async function privateRun(requesterId: number | null, requestId = 'a'.repeat(32)) {
  const metadata = withRequestOrigin({ ci: false }, requestId);
  const [run] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'failed',
      startTime: new Date(T0.getTime() + 60_000),
      metadata,
      origin: runOrigin(metadata),
      requesterId,
    })
    .returning();
  return run!;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.machineRuns = new Set();
  const users = await db
    .insert(schema.users)
    .values([
      { username: 'robin', password: 'x', role: 'member', name: 'Robin' },
      { username: 'sam', password: 'x', role: 'member', name: 'Sam' },
    ])
    .returning();
  userId = users[0]!.id;
  otherUserId = users[1]!.id;
  const projects = await db
    .insert(schema.projects)
    .values([{ name: 'shop' }, { name: 'docs' }])
    .returning();
  projectId = projects[0]!.id;
  otherProjectId = projects[1]!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
  await db.insert(schema.roleBindings).values([
    { userId, projectId, role: 'contributor' },
    { userId: otherUserId, projectId, role: 'contributor' },
  ]);
  state.machineRuns.add(projectId);
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'failed', startTime: T0, branch: 'main', origin: 'ci' })
    .returning();
  sourceRunId = run!.id;
});

describe('a run token', () => {
  test('is given by Run, kept only as a digest, and starts one run', async () => {
    const { id, token } = await ranRequest();
    expect(token).toMatch(/^pdq_[0-9a-f]{64}$/);
    const row = await stored(id);
    expect(row.runTokenDigest).toBeTruthy();
    expect(row.runTokenDigest).not.toContain(token);
    expect(row.runTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + RUN_TOKEN_LIFETIME_MS - 60_000);

    const event = bearer(token);
    const grant = await spendRunToken(event, {});
    expect(grant).toMatchObject({ requestId: id, projectId, requester: { id: userId } });
    expect(event.context.access).toBeTruthy();
    expect((await stored(id)).runTokenDigest).toBeNull();
    await expect(spendRunToken(bearer(token), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  test('is read from x-api-key too, and an API key or no credential is left to the route', async () => {
    const { token } = await ranRequest();
    expect(await spendRunToken(eventWith({}), {})).toBeNull();
    expect(await spendRunToken(bearer(generateApiKey().plaintext), {})).toBeNull();
    expect(await spendRunToken(eventWith({ 'x-api-key': token }), {})).toMatchObject({ projectId });
  });

  test('is refused past its lifetime, and once its request ended', async () => {
    const late = await ranRequest();
    await expect(
      spendRunToken(bearer(late.token), {}, new Date(Date.now() + RUN_TOKEN_LIFETIME_MS + 1000)),
    ).rejects.toMatchObject({ statusCode: 401 });

    const ended = await ranRequest();
    await moveRequestState(ended.c, ended.id, { state: 'ended', outcome: 'stopped' }, null);
    await expect(spendRunToken(bearer(ended.token), {})).rejects.toMatchObject({ statusCode: 401 });
    await expect(spendRunToken(bearer('pdq_' + '0'.repeat(64)), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  test('is refused when the requester can no longer ask for runs, or the capability was turned off', async () => {
    const lost = await ranRequest();
    await db.update(schema.roleBindings).set({ role: 'viewer' }).where(eq(schema.roleBindings.userId, userId));
    await expect(spendRunToken(bearer(lost.token), {})).rejects.toMatchObject({ statusCode: 403 });

    await db.update(schema.roleBindings).set({ role: 'contributor' }).where(eq(schema.roleBindings.userId, userId));
    const off = await ranRequest();
    state.machineRuns.delete(projectId);
    await expect(spendRunToken(bearer(off.token), {})).rejects.toMatchObject({ statusCode: 403 });

    // A refused start leaves the token to a retry once the project allows it again.
    state.machineRuns.add(projectId);
    expect(await spendRunToken(bearer(off.token), {})).toMatchObject({ projectId });
  });

  test('is refused once its requester stopped the request', async () => {
    const { id, token } = await ranRequest();
    expect(await stopOwnRequest(db as never, id, userId)).toBe(true);
    await expect(spendRunToken(bearer(token), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  test('needs sign-in turned on', async () => {
    const { token } = await ranRequest();
    process.env.PIWI_AUTH_ENABLED = 'false';
    vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));
    try {
      await expect(spendRunToken(bearer(token), {})).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      process.env.PIWI_AUTH_ENABLED = 'true';
    }
  });

  test('reports into the request’s project, never a sharded run', async () => {
    const { token } = await ranRequest();
    await expect(spendRunToken(bearer(token), { shardTotal: 2 })).rejects.toMatchObject({ statusCode: 422 });
    const grant = (await spendRunToken(bearer(token), { shardTotal: 1 }))!;
    expect((await grantedProject(db as never, grant)).id).toBe(projectId);
    expect(otherProjectId).not.toBe(projectId);
  });

  test('binds the run it started to its request', async () => {
    const { id, token } = await ranRequest();
    const grant = (await spendRunToken(bearer(token), {}))!;
    const run = await privateRun(userId, id);
    await bindRunToRequest(db as never, grant, run.id);
    expect((await stored(id)).runId).toBe(run.id);
  });
});

describe('the request origin', () => {
  test('is never taken from the reporter', () => {
    expect(sanitizeMetadata({ piwiOrigin: { kind: 'request', ref: 'a'.repeat(32) } })?.piwiOrigin).toBeUndefined();
    expect(sanitizeMetadata({ piwiOrigin: { kind: 'probe', ref: 'p1' } })?.piwiOrigin).toEqual({
      kind: 'probe',
      ref: 'p1',
    });
  });

  test('is stamped by the server and carried over the reporter’s later metadata', () => {
    const stamped = withRequestOrigin({ ci: false }, 'a'.repeat(32));
    expect(runOrigin(stamped)).toBe('request');
    const next = sanitizeMetadata({ ci: false, piwiOrigin: { kind: 'local' } });
    expect(runOrigin(carryRequestOrigin(next, stamped))).toBe('request');
    expect(carryRequestOrigin(next, { ci: true })).toBe(next);
  });

  test('wins over the lab stamps a reporter writes', () => {
    const stamped = withRequestOrigin({ piwiProbe: true, piwiFlakeLab: { experimentId: 1 } }, 'a'.repeat(32));
    expect(runOrigin(stamped)).toBe('request');
    expect(stamped).not.toHaveProperty('piwiProbe');
    const next = sanitizeMetadata({ piwiProbe: true, piwiFlakeLab: { experimentId: 1 } });
    const carried = carryRequestOrigin(next, stamped);
    expect(runOrigin(carried)).toBe('request');
    expect(carried).not.toHaveProperty('piwiFlakeLab');
    expect(runOrigin({ piwiProbe: true, piwiOrigin: { kind: 'request', ref: 'r' } })).toBe('request');
  });

  test('sets the run aside from every team use', () => {
    expect(isLabRun(withRequestOrigin(null, 'a'.repeat(32)))).toBe(true);
  });
});

describe('a private run', () => {
  test('is seen by its requester alone, and by nobody once it has none', () => {
    expect(isVisibleRun({ origin: 'request', requesterId: userId }, userId)).toBe(true);
    expect(isVisibleRun({ origin: 'request', requesterId: userId }, otherUserId)).toBe(false);
    expect(isVisibleRun({ origin: 'request', requesterId: userId }, null)).toBe(false);
    expect(isVisibleRun({ origin: 'request', requesterId: null }, null)).toBe(false);
    expect(isVisibleRun({ origin: 'ci', requesterId: null }, null)).toBe(true);
  });

  test('reads as missing to anyone else, through its run and its executions', async () => {
    const run = await privateRun(userId);
    const [testCase] = await db
      .insert(schema.testCases)
      .values({ projectId, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card' })
      .returning();
    const [execution] = await db
      .insert(schema.testRunsCases)
      .values(withStoredVerdicts([{ testRunId: run.id, testCaseId: testCase!.id, status: 'failed' }]))
      .returning();
    expect(await resolveRunProjectId(db as never, run.id, userId)).toBe(projectId);
    expect(await resolveRunProjectId(db as never, run.id, otherUserId)).toBeNull();
    expect(await resolveRunProjectId(db as never, run.id, null)).toBeNull();
    expect(await resolveTestRunCaseProjectId(db as never, execution!.id, userId)).toBe(projectId);
    expect(await resolveTestRunCaseProjectId(db as never, execution!.id, otherUserId)).toBeNull();
    expect(await resolveRunProjectId(db as never, sourceRunId, otherUserId)).toBe(projectId);
  });

  test('is never a project’s latest run, except to its requester asking for it by its origin', async () => {
    const requestId = 'b'.repeat(32);
    const run = await privateRun(userId, requestId);
    const origin = { kind: 'request' as const, ref: requestId };
    expect((await getProjectLatestRun(db as never, projectId))?.id).toBe(sourceRunId);
    expect((await getProjectLatestRun(db as never, projectId, null, userId))?.id).toBe(sourceRunId);
    expect((await getProjectLatestRun(db as never, projectId, origin, userId))?.id).toBe(run.id);
    expect(await getProjectLatestRun(db as never, projectId, origin, otherUserId)).toBeNull();
    expect(await getProjectLatestRun(db as never, projectId, origin, null)).toBeNull();
  });

  test('is left out of every list a project’s members read', async () => {
    const run = await privateRun(userId);
    await db
      .update(schema.testRuns)
      .set({ label: 'checkout retry', keptAt: new Date(), status: 'running' })
      .where(eq(schema.testRuns.id, run.id));
    const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);
    expect(ids((await getProject(db as never, projectId)).testRuns)).toEqual([sourceRunId]);
    expect((await listKeptRuns(db as never, projectId)).total).toBe(0);
    expect(ids(await getRecentTestRuns(db as never))).not.toContain(run.id);
    expect(ids(await getActiveTestRuns(db as never))).not.toContain(run.id);
    expect((await searchProjectsTestRunsCases(db as never, 'checkout retry')).runs).toEqual([]);
    const listed = (await listProjects(db as never)).find((p: { id: number }) => p.id === projectId);
    expect(listed).toMatchObject({ totalRuns: 1 });
    expect(((await getTestRun(db as never, sourceRunId)) as any)?.project?.latestRunId).toBe(sourceRunId);
  });

  test('is missing to the MCP tools of anyone else, and left out of their lists', async () => {
    const run = await privateRun(userId);
    const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!.handler;
    const [other] = await db.select().from(schema.users).where(eq(schema.users.id, otherUserId));
    const ctx = { user: other, access: ADMIN_ACCESS, scope: 'all' } as never;
    expect(await tool('get_run')(db as never, { runId: run.id }, ctx)).toBeNull();
    const listed = (await tool('list_runs')(db as never, { projectId }, ctx)) as { items: Array<{ id: number }> };
    expect(listed.items.map((r) => r.id)).toEqual([sourceRunId]);
    const recent = (await tool('list_recent_activity')(db as never, {}, ctx)) as { items: Array<{ id: number }> };
    expect(recent.items.map((r) => r.id)).toEqual([sourceRunId]);
  });

  test('reads as missing to the routes that take its id as an argument', async () => {
    const run = await privateRun(userId);
    await expect(getBranchFailures(db as never, projectId, null, { run: run.id })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getBranchFailures(db as never, projectId, null, { run: sourceRunId })).resolves.toBeTruthy();
  });

  test('is diagnosed by nobody else through the MCP tools', async () => {
    const run = await privateRun(userId);
    const [testCase] = await db
      .insert(schema.testCases)
      .values({ projectId, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card' })
      .returning();
    const [execution] = await db
      .insert(schema.testRunsCases)
      .values(withStoredVerdicts([{ testRunId: run.id, testCaseId: testCase!.id, status: 'failed', error: 'boom' }]))
      .returning();
    const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!.handler;
    const [other] = await db.select().from(schema.users).where(eq(schema.users.id, otherUserId));
    const ctx = { user: other, access: ADMIN_ACCESS, scope: 'all' } as never;
    expect(await tool('run_execution_diagnosis')(db as never, { executionId: execution!.id }, ctx)).toBeNull();
    expect(
      await tool('record_diagnosis')(
        db as never,
        {
          executionId: execution!.id,
          model: 'model-a',
          diagnosis: {
            summary: 'The cart total subtracts instead of adding',
            confidenceScore: 80,
            severity: 'high',
            affectedArea: 'cart',
            hypotheses: [{ category: 'app-bug', rootCause: 'total() subtracts', likelihood: 80, evidence: [] }],
            suggestedFix: { description: 'Add the operands', file: 'src/cart.ts', code: null, patch: null },
            investigationSteps: [],
            preventionTips: [],
          },
        },
        ctx,
      ),
    ).toBeNull();
  });

  test('matches only the tests the project knows, and adds no test or suite', async () => {
    const run = await privateRun(userId);
    const [known] = await db
      .insert(schema.testCases)
      .values({ projectId, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card' })
      .returning();
    const testOf = (title: string, suitePath: string[] = []) => ({
      title,
      filePath: 'tests/checkout.spec.ts',
      suitePath,
      status: 'passed',
      retries: 0,
      line: 3,
      column: 1,
      browser: { projectName: 'chromium' },
    });
    await persistRunCases(db as never, projectId, run.id, [
      testOf('pays with a saved card'),
      testOf('a test only this branch has', ['new suite']),
    ] as never);
    const tests = await db.select().from(schema.testCases).where(eq(schema.testCases.projectId, projectId));
    expect(tests.map((t) => t.id)).toEqual([known!.id]);
    expect(await db.select().from(schema.testSuites)).toEqual([]);
    const executions = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, run.id));
    expect(executions.map((e) => e.testCaseId)).toEqual([known!.id]);
  });

  test('is seen by nobody once its requester is deleted', async () => {
    const run = await privateRun(userId);
    await deleteUserRecord(db as never, userId);
    const [row] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, run.id));
    expect(row!.requesterId).toBeNull();
    expect(isVisibleRun(row!, userId)).toBe(false);
  });
});
