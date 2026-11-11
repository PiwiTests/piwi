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
vi.stubGlobal(
  'getRequestHeader',
  (event: { node: { req: { headers: Record<string, string> } } }, name: string) => event.node.req.headers[name],
);
vi.stubGlobal('getRouterParam', (event: { params?: Record<string, string> }, name: string) => event.params?.[name]);

const { generateApiKey, getUserByApiKey, requireAuth } = await import('../../server/utils/auth');
const {
  answerRequest,
  claimRequest,
  countWaitingRequests,
  effectiveState,
  endStaleRequests,
  findOwnRequest,
  moveRequestState,
  pruneRunRequests,
  requestsForTarget,
  requireRunTarget,
  resolveRequestTests,
  stopOwnRequest,
} = await import('../../server/utils/run-requests');
const { listOwnRequests } = await import('#shared/handlers/run-requests');
const { RUN_REQUEST_LIMITS } = await import('@piwitests/core/run-request');
const { buildAccessSummary, InstanceRole, ProjectRole } = await import('#shared/permissions');

let db: Db;
let userId: number;
let otherUserId: number;
let allowed: number;
let viewOnly: number;
let runId: number;

const T0 = new Date('2026-09-01T10:00:00Z');

function eventWithKey(key: string | null): H3Event {
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  return { context: {}, node: { req: { headers }, res: {} } } as unknown as H3Event;
}

async function key(owner: number, permissions: string[] | null) {
  const made = generateApiKey();
  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      userId: owner,
      name: 'Piwi Desktop on LAPTOP-42 (macOS)',
      keyHash: made.hash,
      keyPrefix: made.prefix,
      permissions,
    })
    .returning();
  return { plaintext: made.plaintext, id: row!.id };
}

async function target(owner = userId, permissions: string[] | null = ['run:receive']) {
  const made = await key(owner, permissions);
  const [row] = await db
    .insert(schema.runTargets)
    .values({ userId: owner, apiKeyId: made.id, kind: 'desktop', deviceName: 'Piwi Desktop on LAPTOP-42 (macOS)' })
    .returning();
  return { ...made, targetId: row!.id };
}

let nextId = 0;
async function request(values: Partial<typeof schema.runRequests.$inferInsert> = {}) {
  const id = (++nextId).toString(16).padStart(32, '0');
  await db.insert(schema.runRequests).values({
    id,
    projectId: allowed,
    requesterId: userId,
    kind: 'run',
    tests: [{ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' }],
    options: { headed: true },
    source: { runId },
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: T0,
    updatedAt: T0,
    ...values,
  });
  return id;
}

async function stored(id: string) {
  const [row] = await db.select().from(schema.runRequests).where(eq(schema.runRequests.id, id));
  return row!;
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
  allowed = projects[0]!.id;
  viewOnly = projects[1]!.id;
  await db.insert(schema.roleBindings).values([
    { userId, projectId: allowed, role: 'contributor' },
    { userId, projectId: viewOnly, role: 'viewer' },
  ]);
  state.machineRuns.add(allowed).add(viewOnly);
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: allowed, status: 'failed', startTime: T0, branch: 'main', commit: '9f8e7d6' })
    .returning();
  runId = run!.id;
  const cases = await db
    .insert(schema.testCases)
    .values([
      { projectId: allowed, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card' },
      { projectId: allowed, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
    ])
    .returning();
  const checkout = { testRunId: runId, testCaseId: cases[0]!.id, status: 'failed', line: 12 };
  await db.insert(schema.testRunsCases).values(
    withStoredVerdicts([
      { ...checkout, browserName: 'chromium', retries: 0, finalAttempt: false },
      { ...checkout, browserName: 'chromium', retries: 1 },
      { ...checkout, browserName: 'firefox' },
      { testRunId: runId, testCaseId: cases[1]!.id, status: 'passed', line: 4, browserName: 'chromium' },
    ]),
  );
});

describe('a target key', () => {
  test('serves the target routes', async () => {
    const t = await target();
    const caller = await requireRunTarget(eventWithKey(t.plaintext));
    expect(caller.target.id).toBe(t.targetId);
    expect(caller.target.lastSeenAt).toBeInstanceOf(Date);
  });

  test('is refused by every other route, and never resolves to its owner', async () => {
    const t = await target();
    await expect(requireAuth(eventWithKey(t.plaintext), 'project:read')).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireAuth(eventWithKey(t.plaintext), 'signed-in')).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireAuth(eventWithKey(t.plaintext), 'run:receive')).rejects.toMatchObject({ statusCode: 403 });
    expect(await getUserByApiKey(t.plaintext)).toBeNull();
  });

  test('an owner’s key, a key with other permissions, or no key is refused by the target routes', async () => {
    const owner = await key(userId, null);
    await expect(requireRunTarget(eventWithKey(owner.plaintext))).rejects.toMatchObject({ statusCode: 403 });
    const wider = await target(userId, ['run:receive', 'project:read']);
    await expect(requireRunTarget(eventWithKey(wider.plaintext))).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireRunTarget(eventWithKey(null))).rejects.toMatchObject({ statusCode: 401 });
    await expect(requireRunTarget(eventWithKey('pd_unknown'))).rejects.toMatchObject({ statusCode: 401 });
  });

  test('an owner’s key still acts as its owner', async () => {
    const owner = await key(userId, null);
    expect((await requireAuth(eventWithKey(owner.plaintext), 'project:read')).id).toBe(userId);
    expect((await getUserByApiKey(owner.plaintext))?.id).toBe(userId);
  });

  test('a target key without its target row, or with another user’s, is refused', async () => {
    const orphan = await key(userId, ['run:receive']);
    await expect(requireRunTarget(eventWithKey(orphan.plaintext))).rejects.toMatchObject({ statusCode: 403 });
    const t = await target();
    await db.update(schema.runTargets).set({ userId: otherUserId }).where(eq(schema.runTargets.id, t.targetId));
    await expect(requireRunTarget(eventWithKey(t.plaintext))).rejects.toMatchObject({ statusCode: 403 });
  });

  test('needs sign-in turned on', async () => {
    const t = await target();
    process.env.PIWI_AUTH_ENABLED = 'false';
    vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));
    try {
      await expect(requireRunTarget(eventWithKey(t.plaintext))).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      process.env.PIWI_AUTH_ENABLED = 'true';
    }
  });
});

describe('resolveRequestTests', () => {
  test('the failed tests of a run: final attempts, one per test and Playwright project', async () => {
    const resolved = await resolveRequestTests(db as never, { runId, tests: 'failed' });
    expect(resolved).toEqual({
      ok: true,
      projectId: allowed,
      tests: [
        { filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' },
        { filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'firefox' },
      ],
      skipped: 0,
      source: { runId, branch: 'main', commit: '9f8e7d6' },
      projects: ['chromium', 'firefox'],
    });
  });

  test('leaves out a test the parser refuses or that has no line, and counts it', async () => {
    const odd = await db
      .insert(schema.testCases)
      .values([
        { projectId: allowed, filePath: 'tests/.*', title: 'a pattern for a path' },
        { projectId: allowed, filePath: 'tests/cart.spec.ts', title: 'shows the total\u202e' },
        { projectId: allowed, filePath: 'tests/cart.spec.ts', title: 'from an older reporter' },
        { projectId: allowed, filePath: 'tests/cart.spec.ts', title: 'on a phone' },
      ])
      .returning();
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts([
        { testRunId: runId, testCaseId: odd[0]!.id, status: 'passed', line: 3, browserName: 'chromium' },
        { testRunId: runId, testCaseId: odd[1]!.id, status: 'passed', line: 8, browserName: 'chromium' },
        { testRunId: runId, testCaseId: odd[2]!.id, status: 'passed', line: null, browserName: 'chromium' },
        { testRunId: runId, testCaseId: odd[3]!.id, status: 'passed', line: 9, browserName: 'Pixel 5 (mobile)' },
      ]),
    );
    const all = await resolveRequestTests(db as never, { runId, tests: 'all' });
    expect(all).toMatchObject({ ok: true, skipped: 3 });
    expect(all.ok && all.tests.map((t) => t.title)).toContain('on a phone');

    const only = await resolveRequestTests(db as never, { runId, filePath: 'tests/.*' });
    expect(only).toMatchObject({ ok: false, statusCode: 422 });
  });

  test('a SHA-256 commit is kept, and a branch git refuses is left out rather than refusing the request', async () => {
    await db
      .update(schema.testRuns)
      .set({ commit: 'a'.repeat(64), branch: 'main..evil' })
      .where(eq(schema.testRuns.id, runId));
    const resolved = await resolveRequestTests(db as never, { runId, tests: 'failed' });
    expect(resolved).toMatchObject({ ok: true, source: { runId, commit: 'a'.repeat(64) } });
    expect(resolved.ok && resolved.source.branch).toBeUndefined();
  });

  test('refuses more than 200 tests', async () => {
    const many = await db
      .insert(schema.testCases)
      .values(
        Array.from({ length: 200 }, (_, i) => ({ projectId: allowed, filePath: 'tests/many.spec.ts', title: `t${i}` })),
      )
      .returning();
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts(
        many.map((c, i) => ({
          testRunId: runId,
          testCaseId: c.id,
          status: 'passed',
          line: i + 1,
          browserName: 'chromium',
        })),
      ),
    );
    expect(await resolveRequestTests(db as never, { runId, tests: 'all' })).toMatchObject({
      ok: false,
      statusCode: 422,
      message: 'A request runs at most 200 tests; these are more',
    });
  });

  test('all tests of a run, or one spec file', async () => {
    const all = await resolveRequestTests(db as never, { runId, tests: 'all' });
    expect(all.ok && all.tests).toHaveLength(3);
    const file = await resolveRequestTests(db as never, { runId, filePath: 'tests/cart.spec.ts' });
    expect(file.ok && file.tests.map((t) => t.title)).toEqual(['adds an item']);
  });

  test('a run or a file with nothing to run', async () => {
    expect(await resolveRequestTests(db as never, { runId: 999, tests: 'all' })).toMatchObject({ statusCode: 404 });
    expect(await resolveRequestTests(db as never, { runId, filePath: 'tests/none.spec.ts' })).toMatchObject({
      statusCode: 422,
    });
  });
});

describe('the life of a request', () => {
  async function caller() {
    return requireRunTarget(eventWithKey((await target()).plaintext));
  }

  test('a target lists its owner’s waiting requests, on projects it may run', async () => {
    const c = await caller();
    const mine = await request();
    await request({ requesterId: otherUserId });
    await request({ projectId: viewOnly });
    await request({ expiresAt: new Date(Date.now() - 1000) });
    const { requests } = await requestsForTarget(c);
    expect(requests.map((r) => r.id)).toEqual([mine]);
  });

  test('a project with the capability off is left out, and its requests cannot be claimed', async () => {
    const c = await caller();
    const id = await request();
    state.machineRuns.delete(allowed);
    expect((await requestsForTarget(c)).requests).toEqual([]);
    expect(await claimRequest(c, id)).toMatchObject({ ok: false, statusCode: 403 });
  });

  test('a request is claimed once', async () => {
    const first = await caller();
    const second = await caller();
    const id = await request();
    expect(await claimRequest(first, id)).toMatchObject({ ok: true });
    expect(await claimRequest(second, id)).toMatchObject({ ok: false, statusCode: 409 });
    expect(await claimRequest(first, id)).toMatchObject({ ok: false, statusCode: 409 });
    expect((await stored(id)).targetId).toBe(first.target.id);
  });

  test('another person’s request, or an unknown one, is missing', async () => {
    const c = await caller();
    const theirs = await request({ requesterId: otherUserId });
    expect(await claimRequest(c, theirs)).toMatchObject({ ok: false, statusCode: 404 });
    expect(await claimRequest(c, 'f'.repeat(32))).toMatchObject({ ok: false, statusCode: 404 });
  });

  test('a request sent to one target is not another’s', async () => {
    const c = await caller();
    const other = await caller();
    const id = await request({ targetId: other.target.id });
    expect((await requestsForTarget(c)).requests).toEqual([]);
    expect(await claimRequest(c, id)).toMatchObject({ ok: false, statusCode: 409 });
  });

  test('an expired request reads expired and cannot be claimed', async () => {
    const c = await caller();
    const id = await request({ expiresAt: new Date(Date.now() - 1000) });
    expect(effectiveState(await stored(id))).toBe('expired');
    expect(await claimRequest(c, id)).toMatchObject({ ok: false, statusCode: 409 });
  });

  test('Run, then running, stopping and ended, only forward', async () => {
    const c = await caller();
    const id = await request();
    await claimRequest(c, id);
    expect(await moveRequestState(c, id, { state: 'running' }, null)).toMatchObject({ ok: false, statusCode: 409 });
    expect(await answerRequest(c, id, { decision: 'run' })).toMatchObject({ ok: true, row: { state: 'starting' } });
    expect(await answerRequest(c, id, { decision: 'not-now' })).toMatchObject({ ok: false, statusCode: 409 });
    expect(await moveRequestState(c, id, { state: 'running' }, null)).toMatchObject({ ok: true });
    expect(await moveRequestState(c, id, { state: 'stopping' }, null)).toMatchObject({ ok: true });
    expect(await moveRequestState(c, id, { state: 'running' }, null)).toMatchObject({ ok: false, statusCode: 409 });
    expect(await moveRequestState(c, id, { state: 'ended', outcome: 'stopped' }, null)).toMatchObject({
      ok: true,
      row: { state: 'ended', outcome: 'stopped' },
    });
    expect(await moveRequestState(c, id, { state: 'ended', outcome: 'passed' }, null)).toMatchObject({
      ok: false,
      statusCode: 409,
    });
  });

  test('only the target that claimed it answers it', async () => {
    const c = await caller();
    const other = await caller();
    const id = await request();
    await claimRequest(c, id);
    expect(await answerRequest(other, id, { decision: 'run' })).toMatchObject({ ok: false, statusCode: 409 });
  });

  test('Not now and a failed check end the request', async () => {
    const c = await caller();
    const declined = await request();
    await claimRequest(c, declined);
    expect(await answerRequest(c, declined, { decision: 'not-now' })).toMatchObject({ row: { state: 'declined' } });
    const refused = await request();
    await claimRequest(c, refused);
    expect(
      await answerRequest(c, refused, { decision: 'refused', detail: 'This folder is on another branch' }),
    ).toMatchObject({
      row: { state: 'refused', detail: 'This folder is on another branch' },
    });
  });

  test('a stop ends a waiting or an unanswered request at once, and the target hears of the claimed one', async () => {
    const c = await caller();
    const waiting = await request();
    expect(await stopOwnRequest(db as never, waiting, userId)).toBe(true);
    expect(await stored(waiting)).toMatchObject({ state: 'ended', outcome: 'stopped' });
    expect(await stopOwnRequest(db as never, waiting, userId)).toBe(false);

    const claimed = await request();
    await claimRequest(c, claimed);
    expect(await stopOwnRequest(db as never, claimed, otherUserId)).toBe(false);
    expect(await stopOwnRequest(db as never, claimed, userId)).toBe(true);
    expect(await stored(claimed)).toMatchObject({ state: 'ended', outcome: 'stopped' });
    expect((await requestsForTarget(c)).stops).toEqual([claimed]);
    expect(await answerRequest(c, claimed, { decision: 'run' })).toMatchObject({ ok: false, statusCode: 409 });
  });

  test('names the requests a target holds, claimed or with their run, and none once they end', async () => {
    const c = await caller();
    const claimed = await request();
    await claimRequest(c, claimed);
    const run = await request();
    await claimRequest(c, run);
    await answerRequest(c, run, { decision: 'run' });
    await request();
    const held = (await requestsForTarget(c)).held;
    expect(held).toHaveLength(2);
    expect(held).toEqual(
      expect.arrayContaining([
        { id: claimed, state: 'claimed' },
        { id: run, state: 'starting' },
      ]),
    );
    await moveRequestState(c, run, { state: 'ended', outcome: 'error' }, null);
    await answerRequest(c, claimed, { decision: 'not-now' });
    expect((await requestsForTarget(c)).held).toEqual([]);
  });

  test('a stop of a run reaches its target, which ends it', async () => {
    const c = await caller();
    const id = await request();
    await claimRequest(c, id);
    await answerRequest(c, id, { decision: 'run' });
    expect(await stopOwnRequest(db as never, id, userId)).toBe(true);
    expect(await stored(id)).toMatchObject({ state: 'starting' });
    expect((await requestsForTarget(c)).stops).toEqual([id]);
    await moveRequestState(c, id, { state: 'ended', outcome: 'stopped' }, null);
    expect((await requestsForTarget(c, new Date(Date.now() + 10 * 60_000 + 1000))).stops).toEqual([]);
  });

  test('a second stop, past the grace, ends a run the target did not end', async () => {
    const c = await caller();
    const id = await request();
    await claimRequest(c, id);
    await answerRequest(c, id, { decision: 'run' });
    await moveRequestState(c, id, { state: 'running' }, null);
    const first = new Date();
    expect(await stopOwnRequest(db as never, id, userId, first)).toBe(true);
    expect(await stopOwnRequest(db as never, id, userId, new Date(first.getTime() + 1000))).toBe(true);
    expect(await stored(id)).toMatchObject({ state: 'running' });
    const later = new Date(first.getTime() + RUN_REQUEST_LIMITS.stopGraceMs + 1);
    expect(await stopOwnRequest(db as never, id, userId, later)).toBe(true);
    expect(await stored(id)).toMatchObject({ state: 'ended', outcome: 'stopped' });
    expect((await requestsForTarget(c, later)).stops).toEqual([id]);
  });

  test('a claimed request nobody answers ends, and so does a run whose target was disconnected', async () => {
    const t = await target();
    const c = await requireRunTarget(eventWithKey(t.plaintext));
    const claimed = await request();
    await claimRequest(c, claimed);
    const running = await request();
    await claimRequest(c, running);
    await answerRequest(c, running, { decision: 'run' });
    const claimedAt = (await stored(claimed)).claimedAt!;
    expect(await endStaleRequests(db as never, new Date(claimedAt.getTime() + 60_000))).toBe(0);
    expect(await endStaleRequests(db as never, new Date(claimedAt.getTime() + 10 * 60_000 + 1), claimed)).toBe(1);
    expect(await stored(claimed)).toMatchObject({ state: 'ended', outcome: 'error' });

    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, t.id));
    expect(await endStaleRequests(db as never)).toBe(1);
    expect(await stored(running)).toMatchObject({ state: 'ended', outcome: 'error' });
  });

  test('a request held by a target that went silent ends as an error', async () => {
    const c = await caller();
    const id = await request();
    await claimRequest(c, id);
    await answerRequest(c, id, { decision: 'run' });
    const seen = c.target.lastSeenAt!;
    expect(await endStaleRequests(db as never, new Date(seen.getTime() + 60_000))).toBe(0);
    const silent = new Date(seen.getTime() + RUN_REQUEST_LIMITS.silentTargetMs + 1);
    expect(await endStaleRequests(db as never, silent, 'f'.repeat(32))).toBe(0);
    expect(await endStaleRequests(db as never, silent, id)).toBe(1);
    expect(await stored(id)).toMatchObject({ state: 'ended', outcome: 'error' });
    expect((await stored(id)).detail).toMatch(/stopped answering/);
  });

  test('a waiting request that no longer parses ends with words, rather than vanishing', async () => {
    const c = await caller();
    const id = await request({ tests: [{ filePath: '.*', title: 'x', line: 1, projectName: null }] });
    expect((await requestsForTarget(c)).requests).toEqual([]);
    expect(await stored(id)).toMatchObject({ state: 'ended', outcome: 'error' });
    expect((await stored(id)).detail).toMatch(/ask for the run again/);
  });

  test('counts a person’s waiting requests, and prunes old ended and expired ones', async () => {
    await request();
    await request();
    await request({ expiresAt: new Date(Date.now() - 1000) });
    await request({ requesterId: otherUserId });
    expect(await countWaitingRequests(db as never, userId)).toBe(2);

    const now = new Date('2026-12-01T00:00:00Z');
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const oldEnded = await request({ state: 'ended', outcome: 'passed', updatedAt: old });
    const oldExpired = await request({ expiresAt: old, updatedAt: old });
    const oldRunning = await request({ state: 'running', updatedAt: old });
    const recent = await request({ state: 'declined', updatedAt: now });
    expect(await pruneRunRequests(db as never, 30, now)).toBe(2);
    const left = (await db.select({ id: schema.runRequests.id }).from(schema.runRequests)).map((r) => r.id);
    expect(left).not.toContain(oldEnded);
    expect(left).not.toContain(oldExpired);
    expect(left).toContain(oldRunning);
    expect(left).toContain(recent);
  });

  test('a requester who lost the project no longer reads their request', async () => {
    const id = await request();
    const viewerOf = (projectId: number) =>
      buildAccessSummary(InstanceRole.MEMBER, [{ projectId, role: ProjectRole.VIEWER }]);
    expect(await findOwnRequest(db as never, id, userId, viewerOf(allowed))).not.toBeNull();
    expect(await findOwnRequest(db as never, id, userId, viewerOf(viewOnly))).toBeNull();
    expect(await findOwnRequest(db as never, id, otherUserId, viewerOf(allowed))).toBeNull();
  });

  test('the requester lists their own requests, newest first, in the projects they can read', async () => {
    const t = await target();
    const older = await request({ createdAt: new Date(T0.getTime() - 1000) });
    const newer = await request({ targetId: t.targetId });
    await request({ requesterId: otherUserId });
    await request({ projectId: viewOnly });
    const viewer = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: allowed, role: ProjectRole.VIEWER }]);
    const listed = await listOwnRequests(db as never, userId, viewer);
    expect(listed.map((r) => r.id)).toEqual([newer, older]);
    expect(listed[0]!.target).toMatchObject({ id: t.targetId, kind: 'desktop' });
    expect(await listOwnRequests(db as never, userId, viewer, { projectId: viewOnly })).toEqual([]);
    expect((await listOwnRequests(db as never, userId, viewer, { projectId: allowed })).length).toBe(2);
  });

  test('a request whose target was disconnected ends at its stop', async () => {
    const t = await target();
    const c = await requireRunTarget(eventWithKey(t.plaintext));
    const id = await request();
    await claimRequest(c, id);
    await answerRequest(c, id, { decision: 'run' });
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, t.id));
    expect((await stored(id)).targetId).toBeNull();
    expect(await stopOwnRequest(db as never, id, userId)).toBe(true);
    expect(await stored(id)).toMatchObject({ state: 'ended', outcome: 'stopped' });
  });

  test('Run checks the project again, as the claim did', async () => {
    const c = await caller();
    const id = await request();
    await claimRequest(c, id);
    state.machineRuns.delete(allowed);
    expect(await answerRequest(c, id, { decision: 'run' })).toMatchObject({ ok: false, statusCode: 403 });
    expect(await answerRequest(c, id, { decision: 'not-now' })).toMatchObject({ ok: true, row: { state: 'declined' } });
  });

  test('two tests of one title in two describe blocks stay two', async () => {
    const [suiteCase] = await db
      .insert(schema.testCases)
      .values({ projectId: allowed, filePath: 'tests/cart.spec.ts', title: 'adds an item', suitePath: 'guest' })
      .returning();
    await db
      .insert(schema.testRunsCases)
      .values(
        withStoredVerdicts([
          { testRunId: runId, testCaseId: suiteCase!.id, status: 'passed', browserName: 'chromium', line: 9 },
        ]),
      );
    const file = await resolveRequestTests(db as never, { runId, filePath: 'tests/cart.spec.ts' });
    expect(file.ok && file.tests).toHaveLength(2);
  });
});

describe('a key whose permissions column is not a list', () => {
  test('is refused everywhere', async () => {
    const made = await key(userId, null);
    await db.update(schema.apiKeys).set({ permissions: 'run:receive' }).where(eq(schema.apiKeys.id, made.id));
    expect(await getUserByApiKey(made.plaintext)).toBeNull();
    await expect(requireAuth(eventWithKey(made.plaintext), 'project:read')).rejects.toMatchObject({ statusCode: 401 });
  });
});
