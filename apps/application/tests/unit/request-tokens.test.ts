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
const { answerRequest, claimRequest, endStaleRequests, moveRequestState, requireRunTarget, stopOwnRequest } =
  await import('../../server/utils/run-requests');
const { REQUEST_TOKEN_LIFETIME_MS, checkRequestToken, grantedProject, spendRequestToken } =
  await import('../../server/utils/request-tokens');
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
const { resolveDefaultBranch } = await import('../../server/utils/scm/default-branch');
const { applyReporterKeep, keepRun } = await import('#shared/handlers/run-keep');
const { storedFileVisible } = await import('../../server/utils/stored-file-visibility');
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

/** A request claimed and answered **Run**, with the request token the answer returned. */
async function ranRequest() {
  const c = await caller();
  const id = await request();
  await claimRequest(c, id);
  const answered = await answerRequest(c, id, { decision: 'run' });
  if (!answered.ok || !answered.requestToken) throw new Error('Run gave no request token');
  return { c, id, token: answered.requestToken };
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

describe('a request token', () => {
  /** Check the token, store a run for it, then spend it on that run, as `/setup` and `/start` do. */
  async function start(event: H3Event, body: { shardTotal?: unknown } = {}, now?: Date) {
    const grant = await checkRequestToken(event, body, now);
    if (!grant) return null;
    const run = await privateRun(grant.requester.id, grant.requestId);
    await spendRequestToken(db as never, grant, run.id, now);
    return { grant, run };
  }

  test('is given by Run, kept only as a digest, and starts one run', async () => {
    const { id, token } = await ranRequest();
    expect(token).toMatch(/^pdq_[0-9a-f]{64}$/);
    const row = await stored(id);
    expect(row.requestTokenDigest).toBeTruthy();
    expect(row.requestTokenDigest).not.toContain(token);
    expect(row.requestTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + REQUEST_TOKEN_LIFETIME_MS - 60_000);

    const event = bearer(token);
    const started = (await start(event))!;
    expect(started.grant).toMatchObject({ requestId: id, projectId, requester: { id: userId } });
    expect(event.context.access).toBeTruthy();
    const spent = await stored(id);
    expect(spent.requestTokenDigest).toBeNull();
    expect(spent.runId).toBe(started.run.id);
    await expect(checkRequestToken(bearer(token), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  test('is checked without being spent, so a start that stores no run leaves it to a retry', async () => {
    const { id, token } = await ranRequest();
    expect(await checkRequestToken(bearer(token), {})).toMatchObject({ requestId: id });
    expect((await stored(id)).requestTokenDigest).toBeTruthy();
    expect(await start(bearer(token))).toBeTruthy();
  });

  test('starts one run however many starts present it at once: the loser’s run is deleted', async () => {
    const { id, token } = await ranRequest();
    const first = (await checkRequestToken(bearer(token), {}))!;
    const second = (await checkRequestToken(bearer(token), {}))!;
    const won = await privateRun(userId, id);
    const lost = await privateRun(userId, id);
    await spendRequestToken(db as never, first, won.id);
    await expect(spendRequestToken(db as never, second, lost.id)).rejects.toMatchObject({ statusCode: 401 });
    const runs = await db.select({ id: schema.testRuns.id }).from(schema.testRuns);
    expect(runs.map((r) => r.id)).toContain(won.id);
    expect(runs.map((r) => r.id)).not.toContain(lost.id);
    expect((await stored(id)).runId).toBe(won.id);
  });

  test('is read from x-api-key too, and an API key or no credential is left to the route', async () => {
    const { token } = await ranRequest();
    expect(await checkRequestToken(eventWith({}), {})).toBeNull();
    expect(await checkRequestToken(bearer(generateApiKey().plaintext), {})).toBeNull();
    expect(await checkRequestToken(eventWith({ 'x-api-key': token }), {})).toMatchObject({ projectId });
  });

  test('is refused past its lifetime, once its request ended, and once its target was disconnected', async () => {
    const late = await ranRequest();
    await expect(
      checkRequestToken(bearer(late.token), {}, new Date(Date.now() + REQUEST_TOKEN_LIFETIME_MS + 1000)),
    ).rejects.toMatchObject({ statusCode: 401 });

    const ended = await ranRequest();
    await moveRequestState(ended.c, ended.id, { state: 'ended', outcome: 'stopped' }, null);
    await expect(checkRequestToken(bearer(ended.token), {})).rejects.toMatchObject({ statusCode: 401 });
    await expect(checkRequestToken(bearer('pdq_' + '0'.repeat(64)), {})).rejects.toMatchObject({ statusCode: 401 });

    const revoked = await ranRequest();
    await db.update(schema.runRequests).set({ targetId: null }).where(eq(schema.runRequests.id, revoked.id));
    await expect(checkRequestToken(bearer(revoked.token), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  test('ends its request once it expired unspent, and leaves a spent one alone', async () => {
    const unspent = await ranRequest();
    const spent = await ranRequest();
    await start(bearer(spent.token));
    const later = new Date(Date.now() + REQUEST_TOKEN_LIFETIME_MS + 1000);
    await db.update(schema.runTargets).set({ lastSeenAt: later });
    await endStaleRequests(db as never, later, unspent.id);
    await endStaleRequests(db as never, later, spent.id);
    expect(await stored(unspent.id)).toMatchObject({
      state: 'ended',
      outcome: 'error',
      detail: 'The app did not start the run in time',
    });
    expect((await stored(spent.id)).state).not.toBe('ended');
  });

  test('is refused when the requester can no longer ask for runs, or the capability was turned off', async () => {
    const lost = await ranRequest();
    await db.update(schema.roleBindings).set({ role: 'viewer' }).where(eq(schema.roleBindings.userId, userId));
    await expect(checkRequestToken(bearer(lost.token), {})).rejects.toMatchObject({ statusCode: 403 });

    await db.update(schema.roleBindings).set({ role: 'contributor' }).where(eq(schema.roleBindings.userId, userId));
    const off = await ranRequest();
    state.machineRuns.delete(projectId);
    await expect(checkRequestToken(bearer(off.token), {})).rejects.toMatchObject({ statusCode: 403 });

    // A refused start leaves the token to a retry once the project allows it again.
    state.machineRuns.add(projectId);
    expect(await start(bearer(off.token))).toBeTruthy();
  });

  test('is refused once its requester stopped the request', async () => {
    const { id, token } = await ranRequest();
    expect(await stopOwnRequest(db as never, id, userId)).toBe(true);
    await expect(checkRequestToken(bearer(token), {})).rejects.toMatchObject({ statusCode: 401 });
  });

  test('needs sign-in turned on', async () => {
    const { token } = await ranRequest();
    process.env.PIWI_AUTH_ENABLED = 'false';
    vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));
    try {
      await expect(checkRequestToken(bearer(token), {})).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      process.env.PIWI_AUTH_ENABLED = 'true';
    }
  });

  test('reports into the request’s project, never a sharded run', async () => {
    const { token } = await ranRequest();
    await expect(checkRequestToken(bearer(token), { shardTotal: 2 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(checkRequestToken(bearer(token), { shardTotal: '2' })).rejects.toMatchObject({ statusCode: 422 });
    const grant = (await checkRequestToken(bearer(token), { shardTotal: 1 }))!;
    expect((await grantedProject(db as never, grant)).id).toBe(projectId);
    expect(otherProjectId).not.toBe(projectId);
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

  test('never sets the project’s default branch from its metadata', async () => {
    const hinted = { ci: false, defaultBranch: 'my-laptop-branch' };
    expect(await resolveDefaultBranch(db as never, { id: projectId, defaultBranch: null }, hinted)).toBe(
      'my-laptop-branch',
    );
    const stamped = withRequestOrigin(hinted, 'a'.repeat(32));
    expect(await resolveDefaultBranch(db as never, { id: projectId, defaultBranch: null }, stamped)).toBe('main');
  });

  test('is never kept, by the reporter or by hand', async () => {
    const run = await privateRun(userId);
    await applyReporterKeep(db as never, run.id, true);
    await keepRun(db as never, run.id, { source: 'user', userId });
    const [row] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, run.id));
    expect(row!.keptAt).toBeNull();
  });

  test('keeps its stored files from anyone else, under any name a filesystem reads as its folder', async () => {
    const run = await privateRun(userId);
    for (const folder of [
      `run-${run.id}`,
      `RUN-${run.id}`,
      `run-${run.id}.`,
      'RUN-1~1',
      `run-${run.id}::$INDEX_ALLOCATION`,
    ]) {
      expect(
        await storedFileVisible(db as never, projectId, `project-${projectId}/${folder}/1/a.png`, otherUserId),
      ).toBe(false);
    }
    expect(await storedFileVisible(db as never, projectId, `project-${projectId}/run-${run.id}/1/a.png`, userId)).toBe(
      true,
    );
  });

  test('is seen by nobody once its requester is deleted', async () => {
    const run = await privateRun(userId);
    await deleteUserRecord(db as never, userId);
    const [row] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, run.id));
    expect(row!.requesterId).toBeNull();
    expect(isVisibleRun(row!, userId)).toBe(false);
  });
});
