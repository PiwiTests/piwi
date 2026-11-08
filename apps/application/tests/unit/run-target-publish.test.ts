import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import type { H3Event } from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import type { User } from '../../server/database/schema';
import { apiError } from '../../server/utils/api-error';
import { InstanceRole, ProjectRole } from '#shared/permissions';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';

/**
 * The routes that create, stop or revoke what a connected app holds tell its stream: a new request, a stop, and the
 * revoke of its key or of its owner's account.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_AUTH_ENABLED = 'true';

type Db = ReturnType<typeof drizzle<typeof schema>>;
const state = vi.hoisted(() => ({ db: null as unknown, caller: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('#shared/handlers/capabilities', () => ({ isOptInCapabilityOn: async () => true }));
vi.mock('../../server/utils/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/utils/auth')>();
  return {
    ...original,
    requireAuth: async (event: H3Event) => {
      const user = state.caller as User;
      event.context.access = await original.getUserAccessCached(state.db as never, user);
      return user;
    },
  };
});
vi.mock('../../server/utils/project-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/project-access')>()),
  requireProjectPermission: async () => {},
}));
vi.mock('../../server/utils/profile-picture', () => ({ deleteUserProfilePictures: async () => {} }));
vi.stubGlobal('getRequestHeader', (event: { node: { req: { headers: Record<string, string> } } }, name: string) => {
  return event.node.req.headers[name];
});
vi.stubGlobal('getRouterParam', (event: { params?: Record<string, string> }, name: string) => event.params?.[name]);
vi.stubGlobal('readBody', async (event: { body?: unknown }) => event.body);
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('apiError', apiError);

const { generateApiKey } = await import('../../server/utils/auth');
const { resetRunTargetEvents, subscribeRunTarget } = await import('../../server/utils/run-target-events');
type Route = (event: H3Event) => Promise<unknown>;
const route = async (path: string) => (await import(path)).default as Route;
const createRequest = await route('../../server/api/run-requests/index.post');
const stopRequest = await route('../../server/api/run-requests/[id]/stop.post');
const deleteKey = await route('../../server/api/users/[id]/api-keys/[keyId].delete');
const deleteUser = await route('../../server/api/users/[id].delete');
const connectedApps = await route('../../server/api/users/[id]/connected-apps.get');
const claimRequest = await route('../../server/api/run-targets/requests/[id]/claim.post');
const patchCapabilities = await route('../../server/api/capabilities.patch');

let db: Db;
let admin: User;
let robin: User;
let sam: User;
let projectId: number;
let runId: number;

function call(
  handler: Route,
  caller: User,
  params: Record<string, string> = {},
  body?: unknown,
  headers: Record<string, string> = {},
) {
  state.caller = caller;
  const req = { headers, destroyed: false };
  return handler({ context: {}, params, body, node: { req, res: {} } } as unknown as H3Event);
}

/** A connected app of `owner`, with every event its stream would hear. */
async function target(owner: User) {
  const made = generateApiKey();
  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      userId: owner.id,
      name: 'Piwi Desktop on LAPTOP-42 (macOS)',
      keyHash: made.hash,
      keyPrefix: made.prefix,
      permissions: ['run:receive'],
      clientKind: 'desktop',
    })
    .returning();
  const [row] = await db
    .insert(schema.runTargets)
    .values({ userId: owner.id, apiKeyId: key!.id, kind: 'desktop', deviceName: 'Piwi Desktop on LAPTOP-42 (macOS)' })
    .returning();
  const heard: { type: string; [key: string]: unknown }[] = [];
  subscribeRunTarget(row!.id, (event) => heard.push(event));
  return { key: made.plaintext, keyId: key!.id, targetId: row!.id, heard };
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  resetRunTargetEvents();
  [admin, robin, sam] = await db
    .insert(schema.users)
    .values([
      { username: 'alex', password: 'x', role: InstanceRole.ADMINISTRATOR, name: 'Alex' },
      { username: 'robin', password: 'x', role: InstanceRole.MEMBER, name: 'Robin' },
      { username: 'sam', password: 'x', role: InstanceRole.MEMBER, name: 'Sam' },
    ])
    .returning();
  const [project] = await db.insert(schema.projects).values({ name: 'shop' }).returning();
  projectId = project!.id;
  await db.insert(schema.roleBindings).values([
    { userId: robin!.id, projectId, role: ProjectRole.CONTRIBUTOR },
    { userId: sam!.id, projectId, role: ProjectRole.CONTRIBUTOR },
  ]);
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'failed', startTime: new Date(), branch: 'main', origin: 'ci' })
    .returning();
  runId = run!.id;
  const [testCase] = await db
    .insert(schema.testCases)
    .values({ projectId, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card' })
    .returning();
  await db
    .insert(schema.testRunsCases)
    .values(
      withStoredVerdicts([
        { testRunId: runId, testCaseId: testCase!.id, status: 'failed', line: 12, browserName: 'chromium' },
      ]),
    );
});

describe('what a connected app hears from the routes', () => {
  test('a request made from the dashboard, on the requester’s apps alone', async () => {
    const mine = await target(robin);
    const theirs = await target(sam);
    const made = (await call(createRequest, robin, {}, { source: { runId, tests: 'failed' } })) as { id: string };
    expect(mine.heard).toEqual([
      expect.objectContaining({ type: 'request', request: expect.objectContaining({ id: made.id }) }),
    ]);
    expect(theirs.heard).toEqual([]);
  });

  test('the stop of a request it holds', async () => {
    const mine = await target(robin);
    const made = (await call(createRequest, robin, {}, { source: { runId, tests: 'failed' } })) as { id: string };
    await db.update(schema.runRequests).set({ state: 'claimed', targetId: mine.targetId, claimedAt: new Date() });
    await call(stopRequest, robin, { id: made.id });
    expect(mine.heard.at(-1)).toEqual({ type: 'stop', id: made.id });
  });

  test('the withdrawal of a waiting request its requester stopped, on each of their apps', async () => {
    const mine = await target(robin);
    const other = await target(robin);
    const theirs = await target(sam);
    const made = (await call(createRequest, robin, {}, { source: { runId, tests: 'failed' } })) as { id: string };
    await call(stopRequest, robin, { id: made.id });
    expect(mine.heard.at(-1)).toEqual({ type: 'withdrawn', id: made.id });
    expect(other.heard.at(-1)).toEqual({ type: 'withdrawn', id: made.id });
    expect(theirs.heard).toEqual([]);
  });

  test('the withdrawal of a request another of its owner’s apps claimed', async () => {
    const mine = await target(robin);
    const other = await target(robin);
    const made = (await call(createRequest, robin, {}, { source: { runId, tests: 'failed' } })) as { id: string };
    await call(claimRequest, robin, { id: made.id }, undefined, { authorization: `Bearer ${mine.key}` });
    expect(other.heard.at(-1)).toEqual({ type: 'withdrawn', id: made.id });
    expect(mine.heard.map((e) => e.type)).toEqual(['request']);
  });

  test('the revoke of its key', async () => {
    const mine = await target(robin);
    const other = await target(robin);
    await call(deleteKey, robin, { id: String(robin.id), keyId: String(mine.keyId) });
    expect(mine.heard).toEqual([{ type: 'revoked' }]);
    expect(other.heard).toEqual([]);
  });

  test('the delete of its owner’s account, on every app they connected', async () => {
    const first = await target(robin);
    const second = await target(robin);
    const theirs = await target(sam);
    await call(deleteUser, admin, { id: String(robin.id) });
    expect(first.heard).toEqual([{ type: 'revoked' }]);
    expect(second.heard).toEqual([{ type: 'revoked' }]);
    expect(theirs.heard).toEqual([]);
  });
});

describe('turning Run on my machine on', () => {
  test('is refused while sign-in is off', async () => {
    process.env.PIWI_AUTH_ENABLED = 'false';
    vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));
    try {
      await expect(
        call(patchCapabilities, admin, {}, { decisions: { 'machine-runs': 'enabled' } }),
      ).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      process.env.PIWI_AUTH_ENABLED = 'true';
    }
  });
});

describe('Connected apps', () => {
  test('lists a user’s own apps, and another user’s only for an administrator', async () => {
    await target(robin);
    expect(((await call(connectedApps, robin, { id: String(robin.id) })) as { items: unknown[] }).items).toHaveLength(
      1,
    );
    expect(((await call(connectedApps, admin, { id: String(robin.id) })) as { items: unknown[] }).items).toHaveLength(
      1,
    );
    await expect(call(connectedApps, sam, { id: String(robin.id) })).rejects.toMatchObject({ statusCode: 403 });
  });
});
