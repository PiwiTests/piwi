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
  effectiveState,
  moveRequestState,
  requestsForTarget,
  requireRunTarget,
  resolveRequestTests,
  stopOwnRequest,
} = await import('../../server/utils/run-requests');

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
      source: { runId, branch: 'main', commit: '9f8e7d6' },
      projects: ['chromium', 'firefox'],
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

  test('a stop ends a waiting request at once, and reaches the target of a claimed one', async () => {
    const c = await caller();
    const waiting = await request();
    expect(await stopOwnRequest(db as never, waiting, userId)).toBe(true);
    expect(await stored(waiting)).toMatchObject({ state: 'ended', outcome: 'stopped' });
    expect(await stopOwnRequest(db as never, waiting, userId)).toBe(false);

    const claimed = await request();
    await claimRequest(c, claimed);
    expect(await stopOwnRequest(db as never, claimed, otherUserId)).toBe(false);
    expect(await stopOwnRequest(db as never, claimed, userId)).toBe(true);
    expect((await requestsForTarget(c)).stops).toEqual([claimed]);
    expect(await answerRequest(c, claimed, { decision: 'run' })).toMatchObject({ ok: false, statusCode: 409 });
  });
});
