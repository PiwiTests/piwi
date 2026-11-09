import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import type { H3Event } from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { migrateToLatest } from './temp-db';

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
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('apiError', apiError);

const { generateApiKey } = await import('../../server/utils/auth');
const { claimRequest, requireRunTarget } = await import('../../server/utils/run-requests');
const {
  MAX_STREAMS_PER_TARGET,
  RUN_TARGET_ONLINE_MS,
  RUN_TARGET_RECHECK_MS,
  isRunTargetOnline,
  publishRunRequest,
  publishToRunTarget,
  resetRunTargetEvents,
  runTargetStreamCount,
} = await import('../../server/utils/run-target-events');
const { listConnectedApps, listUserApiKeys } = await import('#shared/handlers/users');
const stream = (await import('../../server/api/run-targets/stream.get')).default as (
  event: H3Event,
) => Promise<Response>;

let db: Db;
let userId: number;
let otherUserId: number;
let projectId: number;
let sourceRunId: number;

function eventWithKey(key: string): H3Event {
  const req = Object.assign(new EventEmitter(), { headers: { authorization: `Bearer ${key}` }, destroyed: false });
  return { context: {}, node: { req, res: {} } } as unknown as H3Event;
}

async function target(owner = userId) {
  const made = generateApiKey();
  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      userId: owner,
      name: 'Piwi Desktop on LAPTOP-42 (macOS)',
      keyHash: made.hash,
      keyPrefix: made.prefix,
      permissions: ['run:receive'],
      clientKind: 'desktop',
    })
    .returning();
  const [row] = await db
    .insert(schema.runTargets)
    .values({ userId: owner, apiKeyId: key!.id, kind: 'desktop', deviceName: 'Piwi Desktop on LAPTOP-42 (macOS)' })
    .returning();
  return { key: made.plaintext, keyId: key!.id, targetId: row!.id };
}

let nextId = 0;
async function request(values: Partial<typeof schema.runRequests.$inferInsert> = {}) {
  const id = (++nextId).toString(16).padStart(32, '0');
  const [row] = await db
    .insert(schema.runRequests)
    .values({
      id,
      projectId,
      requesterId: userId,
      kind: 'run',
      tests: [
        { filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' },
      ],
      options: {},
      source: { runId: sourceRunId },
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...values,
    })
    .returning();
  return row!;
}

/** Open a target's stream and collect its events as they come; `whileLoading` runs before its snapshot is read. */
async function open(key: string, whileLoading?: () => void) {
  const event = eventWithKey(key);
  const response = await stream(event);
  whileLoading?.();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { type: string; [key: string]: unknown }[] = [];
  let done = false;
  const pump = (async () => {
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice('data: '.length)));
      }
    }
    done = true;
  })();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  return {
    events,
    settle,
    isDone: () => done,
    leave: async () => {
      (event.node.req as unknown as EventEmitter).emit('close');
      await settle();
    },
    pump,
  };
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.machineRuns = new Set();
  resetRunTargetEvents();
  const users = await db
    .insert(schema.users)
    .values([
      { username: 'robin', password: 'x', role: 'member', name: 'Robin' },
      { username: 'sam', password: 'x', role: 'member', name: 'Sam' },
    ])
    .returning();
  userId = users[0]!.id;
  otherUserId = users[1]!.id;
  const [project] = await db.insert(schema.projects).values({ name: 'shop' }).returning();
  projectId = project!.id;
  await db.insert(schema.roleBindings).values([
    { userId, projectId, role: 'contributor' },
    { userId: otherUserId, projectId, role: 'contributor' },
  ]);
  state.machineRuns.add(projectId);
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'failed', startTime: new Date(), branch: 'main', origin: 'ci' })
    .returning();
  sourceRunId = run!.id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a connected app’s stream', () => {
  test('starts with what the app should act on, then brings each new request', async () => {
    const waiting = await request();
    const { key, targetId } = await target();
    const s = await open(key);
    expect(s.events[0]).toMatchObject({ type: 'snapshot', stops: [] });
    expect(s.events[0]!.requests).toEqual([
      expect.objectContaining({ id: waiting.id, expiresAt: waiting.expiresAt.toISOString() }),
    ]);
    expect(runTargetStreamCount(targetId)).toBe(1);

    const made = await request();
    await publishRunRequest(db as never, made);
    await s.settle();
    expect(s.events[1]).toMatchObject({
      type: 'request',
      request: { id: made.id, expiresAt: made.expiresAt.toISOString() },
    });

    await s.leave();
    expect(runTargetStreamCount(targetId)).toBe(0);
  });

  test('brings a request only to the requester’s own apps, the one it names, on a project open to them', async () => {
    const mine = await target();
    const other = await target();
    const theirs = await target(otherUserId);
    const streams = await Promise.all([open(mine.key), open(other.key), open(theirs.key)]);

    await publishRunRequest(db as never, await request({ targetId: mine.targetId }));
    await streams[0]!.settle();
    expect(streams.map((s) => s.events.filter((e) => e.type === 'request').length)).toEqual([1, 0, 0]);

    await publishRunRequest(db as never, await request());
    await streams[0]!.settle();
    expect(streams.map((s) => s.events.filter((e) => e.type === 'request').length)).toEqual([2, 1, 0]);

    state.machineRuns.delete(projectId);
    await publishRunRequest(db as never, await request());
    await streams[0]!.settle();
    expect(streams.map((s) => s.events.filter((e) => e.type === 'request').length)).toEqual([2, 1, 0]);
    for (const s of streams) await s.leave();
  });

  test('brings what happens while its snapshot loads after the snapshot', async () => {
    const { key, targetId } = await target();
    const s = await open(key, () => publishToRunTarget(targetId, { type: 'stop', id: 'f'.repeat(32) }));
    expect(s.events.map((e) => e.type)).toEqual(['snapshot', 'stop']);
    await s.leave();
  });

  test('brings no request that is no longer waiting', async () => {
    const { key } = await target();
    const s = await open(key);
    await publishRunRequest(db as never, await request({ state: 'claimed' }));
    await s.settle();
    expect(s.events.map((e) => e.type)).toEqual(['snapshot']);
    await s.leave();
  });

  test('brings a stop of a request the app holds', async () => {
    const { key, targetId } = await target();
    const held = await request();
    const caller = await requireRunTarget(eventWithKey(key));
    expect((await claimRequest(caller, held.id)).ok).toBe(true);
    const s = await open(key);
    publishToRunTarget(targetId, { type: 'stop', id: held.id });
    await s.settle();
    expect(s.events.at(-1)).toEqual({ type: 'stop', id: held.id });
    await s.leave();
  });

  test('closes, saying so, when the app is disconnected', async () => {
    const { key, targetId } = await target();
    const s = await open(key);
    publishToRunTarget(targetId, { type: 'revoked' });
    await s.pump;
    expect(s.events.at(-1)).toEqual({ type: 'revoked' });
    expect(s.isDone()).toBe(true);
    expect(runTargetStreamCount(targetId)).toBe(0);
  });

  test('checks its key at each minute without counting as the app being seen, and closes once the key is gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { key, keyId, targetId } = await target();
    const s = await open(key);
    const seen = async () =>
      (await db.select().from(schema.runTargets).where(eq(schema.runTargets.id, targetId)))[0]?.lastSeenAt?.getTime();
    const before = (await seen())!;
    await vi.advanceTimersByTimeAsync(RUN_TARGET_RECHECK_MS);
    await s.settle();
    expect(await seen()).toBe(before);
    expect(s.isDone()).toBe(false);

    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
    await vi.advanceTimersByTimeAsync(RUN_TARGET_RECHECK_MS);
    await s.pump;
    expect(s.events.at(-1)).toEqual({ type: 'revoked' });
    expect(runTargetStreamCount(targetId)).toBe(0);
  });

  test('reads as online only while the app has called the instance within two minutes', async () => {
    const { key, targetId } = await target();
    const s = await open(key);
    const now = Date.now();
    expect(isRunTargetOnline(targetId, new Date(now - 30_000), now)).toBe(true);
    expect(isRunTargetOnline(targetId, new Date(now - RUN_TARGET_ONLINE_MS), now)).toBe(false);
    expect(isRunTargetOnline(targetId, null, now)).toBe(false);
    await s.leave();
    expect(isRunTargetOnline(targetId, new Date(now), now)).toBe(false);
  });

  test('refuses a stream past the cap of one app', async () => {
    const { key } = await target();
    const streams = [];
    for (let i = 0; i < MAX_STREAMS_PER_TARGET; i++) streams.push(await open(key));
    await expect(stream(eventWithKey(key))).rejects.toMatchObject({ statusCode: 429 });
    for (const s of streams) await s.leave();
  });

  test('refuses a credential that is not a connected app’s', async () => {
    await expect(stream(eventWithKey(generateApiKey().plaintext))).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('Connected apps', () => {
  test('lists the apps a user connected, newest first, with whether one that runs tests is online', async () => {
    const picker = generateApiKey();
    await db.insert(schema.apiKeys).values([
      { userId, name: 'CI', keyHash: generateApiKey().hash, keyPrefix: 'ci000000' },
      {
        userId,
        name: 'Piwi Picker in Chrome on LAPTOP-42',
        keyHash: picker.hash,
        keyPrefix: picker.prefix,
        clientKind: 'picker',
        createdAt: new Date('2026-09-01T10:00:00Z'),
      },
    ]);
    const { key, keyId, targetId } = await target();
    await target(otherUserId);
    const s = await open(key);

    const apps = await listConnectedApps(db as never, userId, (id, seen) => isRunTargetOnline(id, seen));
    expect(apps.map((a) => [a.kind, a.target?.online ?? null])).toEqual([
      ['desktop', true],
      ['picker', null],
    ]);
    expect(apps[0]).toMatchObject({ id: keyId, name: 'Piwi Desktop on LAPTOP-42 (macOS)' });
    // The API keys list still has every key, each saying whether the device flow made it.
    const keys = (await listUserApiKeys(db as never, userId)).apiKeys;
    expect(keys.map((k) => k.clientKind ?? null).sort()).toEqual([null, 'desktop', 'picker'].sort());

    await s.leave();
    expect(
      (await listConnectedApps(db as never, userId, (id, seen) => isRunTargetOnline(id, seen)))[0]!.target?.online,
    ).toBe(false);
    expect(runTargetStreamCount(targetId)).toBe(0);
  });

  test('names only the projects an app may still take requests on', async () => {
    const [other] = await db.insert(schema.projects).values({ name: 'admin' }).returning();
    const { targetId } = await target();
    await db
      .update(schema.runTargets)
      .set({ projectIds: [projectId, other!.id] })
      .where(eq(schema.runTargets.id, targetId));
    const projectsOf = async () =>
      (await listConnectedApps(db as never, userId, () => true)).find((a) => a.target?.id === targetId)!.target!
        .projectIds;
    // No role on the other project.
    expect(await projectsOf()).toEqual([projectId]);
    // The capability turned off.
    state.machineRuns.delete(projectId);
    expect(await projectsOf()).toEqual([]);
  });
});
