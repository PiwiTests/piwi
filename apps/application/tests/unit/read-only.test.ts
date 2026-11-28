/**
 * Read-only mode: while the operator has it on, every write under `/api/` and `/oauth/` is refused with 409
 * `READ_ONLY`, the reporter's and an MCP client's sign-in too, except signing in and out, the operator's routes, the
 * reads sent as POST and a run's live view, however the request spells its path; a GET that writes as a side effect
 * answers without its write, or refuses when the write is its purpose; every scheduled task, the plugins that write
 * and the startup passes skip; and `/api/notice` says so.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as h3 from 'h3';
import { READ_ONLY_MESSAGE, holdOperatorLimits } from '#shared/operator-limits';
import { ADMIN_ACCESS } from '#shared/permissions';
import { apiError } from '../../server/utils/api-error';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/database')>()),
  getDatabase: async () => state.db,
  getDialect: () => 'sqlite',
}));
vi.mock('../../server/utils/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/auth')>()),
  requireAuth: async () => ({ id: 1, role: 'administrator' }),
  getRequestAccess: async () => ADMIN_ACCESS,
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
vi.stubGlobal('defineTask', (task: unknown) => task);
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.context?.params?.[name]);
vi.stubGlobal('getQuery', (event: RouteEvent) => event.query ?? {});
vi.stubGlobal('getRequestHeader', h3.getRequestHeader);
vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));

/** What the route handlers this file calls read of a request. */
interface RouteEvent {
  method?: string;
  path?: string;
  context?: { params?: Record<string, string> };
  query?: Record<string, string>;
  node?: { req: { headers: Record<string, string> } };
}
type Route = (event: RouteEvent) => Promise<Record<string, any>>;

const { readOnlyRefuses } = await import('../../server/utils/read-only-routes');
const { resetOperatorLimits, writeOperatorLimits } = await import('../../server/utils/operator-limits');
const middleware = (await import('../../server/middleware/read-only')).default as unknown as (event: {
  method: string;
  path: string;
}) => Promise<void>;
const notice = (await import('../../server/api/notice.get')).default as unknown as (
  event: unknown,
) => Promise<{ readOnly: boolean }>;
const { storageQuotaState } = await import('../../server/utils/storage-quota');
const { getOrComputeVisualDiff } = await import('../../server/utils/visual-diff');
const { recordShareLinkView } = await import('../../server/utils/share-links');
const flakePlan = (await import('../../server/api/test-cases/[id]/flake-plan.get')).default as unknown as Route;
const openDashboard = (await import('../../server/api/dashboards/[id].get')).default as unknown as Route;
const { createDashboard, dashboardActorFor } = await import('#shared/handlers/dashboards');
const { generateApiKey, resolveApiKey } = await import('../../server/utils/auth');
const { requireRunTarget } = await import('../../server/utils/run-requests');
const { findOrCreateOAuthUser, linkProviderToUser } = await import('../../server/utils/oauth');
const { startAuthorization } = await import('../../server/utils/mcp-oauth');
const { getShardSplit, parseShardSplitRequest } = await import('../../server/utils/shard-split');

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));

afterEach(() => {
  resetOperatorLimits();
  vi.unstubAllEnvs();
});

describe('the requests read-only mode refuses', () => {
  const refused = (method: string, path: string) => readOnlyRefuses(method, path);

  test('every write of the reporter, a run in progress included', () => {
    for (const path of [
      '/api/test-runs/setup',
      '/api/test-runs/start',
      '/api/test-runs/submit',
      '/api/test-runs/upload',
      '/api/test-runs/upload/results',
      '/api/test-runs/import',
      '/api/test-runs/import/check',
      '/api/test-runs/12/begin',
      '/api/test-runs/12/events',
      '/api/test-runs/12/heartbeat',
      '/api/test-runs/12/case-files',
      '/api/test-runs/12/live-resources',
      '/api/test-runs/12/finish',
    ]) {
      expect(refused('POST', path), path).toBe(true);
    }
  });

  test('every other family of writes, whatever its method', () => {
    expect(refused('PUT', '/api/settings/ai')).toBe(true);
    expect(refused('PATCH', '/api/failure-clusters/3/status')).toBe(true);
    expect(refused('DELETE', '/api/projects/4')).toBe(true);
    expect(refused('DELETE', '/api/test-runs/4')).toBe(true);
    expect(refused('POST', '/api/projects/4/bug-reports')).toBe(true);
    expect(refused('POST', '/api/users/1/api-keys')).toBe(true);
    expect(refused('POST', '/api/assistant/conversations')).toBe(true);
    expect(refused('POST', '/api/auth/setup')).toBe(true);
    expect(refused('POST', '/api/auth/reset-password')).toBe(true);
    expect(refused('POST', '/api/test-runs/12/gate')).toBe(true);
    expect(refused('POST', '/api/test-runs/12/live-view/control')).toBe(true);
    expect(refused('POST', '/api/oauth/authorizations/abc/decision')).toBe(true);
  });

  test('an MCP client’s sign-in: its registration, its tokens and their revocation', () => {
    for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/OAUTH/token/']) {
      expect(refused('POST', path), path).toBe(true);
    }
  });

  test('not signing in or out, the operator’s routes, a read sent as POST or a run’s live view', () => {
    for (const [method, path] of [
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/logout'],
      ['PUT', '/api/operator/limits'],
      ['DELETE', '/api/operator/notice'],
      ['POST', '/api/operator/admin-invite'],
      ['POST', '/api/widgets/preview'],
      ['POST', '/api/projects/4/selections/preview'],
      ['POST', '/api/projects/4/selections/impact'],
      ['POST', '/api/reports/schedules/preview'],
      ['POST', '/api/projects/4/run-plans/sources'],
      ['POST', '/api/projects/4/integrations/auto-create-preview'],
      ['POST', '/api/integrations/connections/check'],
      ['POST', '/api/traces/check'],
      ['POST', '/api/ai/step-resolution'],
      ['POST', '/api/projects/4/shard-split'],
      ['POST', '/api/test-runs/12/live-view'],
      ['POST', '/api/test-runs/12/live-view/watch'],
    ] as const) {
      expect(refused(method, path), `${method} ${path}`).toBe(false);
    }
  });

  test('a read path with another method: a selection named preview is not deleted', () => {
    expect(refused('DELETE', '/api/projects/4/selections/preview')).toBe(true);
    expect(refused('PATCH', '/api/projects/4/selections/preview')).toBe(true);
    expect(refused('DELETE', '/api/auth/login')).toBe(true);
  });

  test('no read, and nothing outside the API and the MCP sign-in', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(refused(method, '/api/test-runs/12/export'), method).toBe(false);
    }
    expect(refused('GET', '/oauth/authorize')).toBe(false);
    expect(refused('POST', '/mcp')).toBe(false);
    expect(refused('POST', '/login')).toBe(false);
  });
});

describe('with a database', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    state.db = db;
  });
  afterEach(async () => {
    await close();
  });

  const readOnly = (on: boolean) => writeOperatorLimits(db as never, { readOnly: on });

  /** What the middleware answers a request: null when it lets it through. */
  async function answer(method: string, path: string) {
    try {
      await middleware({ method, path });
      return null;
    } catch (error) {
      const { statusCode, data, message } = error as {
        statusCode: number;
        data: { errorCode: string };
        message: string;
      };
      return { statusCode, errorCode: data.errorCode, message };
    }
  }

  test('the middleware refuses a write with 409 READ_ONLY while read-only, and nothing otherwise', async () => {
    expect(await answer('POST', '/api/test-runs/submit')).toBeNull();
    await readOnly(true);
    expect(await answer('POST', '/api/test-runs/submit')).toEqual({
      statusCode: 409,
      errorCode: 'READ_ONLY',
      message: READ_ONLY_MESSAGE,
    });
    expect(await answer('POST', '/api/test-runs/12/heartbeat')).toMatchObject({ statusCode: 409 });
    expect(await answer('GET', '/api/test-runs')).toBeNull();
    expect(await answer('POST', '/api/auth/login')).toBeNull();
    expect(await answer('PUT', '/api/operator/limits')).toBeNull();
    await readOnly(false);
    expect(await answer('DELETE', '/api/projects/4')).toBeNull();
  });

  test('the middleware follows read-only mode set by another process once the held value is stale', async () => {
    expect(await answer('POST', '/api/test-runs/submit')).toBeNull();
    await db.insert(schema.appSettings).values({ key: 'operator_limits', value: { readOnly: true } });
    resetOperatorLimits();
    expect(await answer('POST', '/api/test-runs/submit')).toMatchObject({ errorCode: 'READ_ONLY' });
  });

  test('/api/notice says whether the instance is read-only', async () => {
    expect((await notice({})).readOnly).toBe(false);
    holdOperatorLimits({ readOnly: true });
    expect((await notice({})).readOnly).toBe(true);
  });

  test('the storage quota’s record of going over is not written while read-only', async () => {
    holdOperatorLimits({ storageQuotaBytes: 1024 * 1024, readOnly: true });
    await db.update(schema.storageTotals).set({ bytes: 2 * 1024 * 1024 });
    const state = await storageQuotaState(db as never);
    expect(state).toMatchObject({ filesRefused: true, over: { ceilingBytes: expect.any(Number) } });
    const record = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'storage_quota_over'));
    expect(record).toEqual([]);
  });

  test('a visual diff not stored yet is not computed while read-only', async () => {
    holdOperatorLimits({ readOnly: true });
    expect(await getOrComputeVisualDiff(db as never, 1)).toEqual({ status: 'read-only' });
  });

  test('a share link’s view is not counted while read-only', async () => {
    const [user] = await db.insert(schema.users).values({ username: 'ro', password: 'x', role: 'member' }).returning();
    const [link] = await db
      .insert(schema.shareLinks)
      .values({ entityKind: 'cluster', entityId: 1, tokenHash: 'h', tokenPrefix: 'p', createdBy: user!.id })
      .returning();
    holdOperatorLimits({ readOnly: true });
    await recordShareLinkView(db as never, link!.id);
    const [after] = await db.select().from(schema.shareLinks).where(eq(schema.shareLinks.id, link!.id));
    expect(after!.viewCount).toBe(0);
  });

  test('every scheduled task skips while read-only', async () => {
    await readOnly(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
    try {
      for (const file of taskFiles()) {
        const task = (await import(/* @vite-ignore */ file)).default as { run(): Promise<{ result: unknown }> };
        expect(await task.run(), relative(APP_DIR, file)).toEqual({ result: { skipped: 'read-only' } });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Every scheduled task's file. */
function taskFiles(): string[] {
  const dir = join(APP_DIR, 'server/tasks');
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));
}

describe('a request that writes as a side effect, while read-only', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    state.db = db;
    await db.insert(schema.users).values({ id: 1, username: 'avery', password: '', role: 'administrator' });
    await db.insert(schema.projects).values({ id: 1, name: 'read-only-project' });
  });
  afterEach(async () => {
    await close();
  });

  const readOnly = (on: boolean) => writeOperatorLimits(db as never, { readOnly: on });

  test('a flake plan answers without recording an experiment', async () => {
    await db.insert(schema.testCases).values({ id: 5, projectId: 1, filePath: 'a.spec.ts', title: 'flaky' });
    const event = { method: 'GET', path: '/api/test-cases/5/flake-plan', context: { params: { id: '5' } }, query: {} };
    await readOnly(true);
    expect((await flakePlan(event)).experimentId).toBeNull();
    expect(await db.select().from(schema.flakeExperiments)).toEqual([]);
    await readOnly(false);
    expect((await flakePlan(event)).experimentId).toEqual(expect.any(String));
  });

  test('a saved dashboard opens without recording the view', async () => {
    const saved = await createDashboard(
      db as never,
      { name: 'Board', visibility: 'shared' },
      dashboardActorFor(null, null),
    );
    await readOnly(true);
    const opened = await openDashboard({ context: { params: { id: String(saved.id) } }, query: {} });
    expect(opened.name).toBe('Board');
    const [row] = await db.select().from(schema.analyticsDashboards);
    expect(row!.lastViewedAt).toBeNull();
  });

  /** A key of user 1, holding `permissions` alone when given. */
  async function apiKey(permissions?: string[]) {
    const key = generateApiKey();
    const [row] = await db
      .insert(schema.apiKeys)
      .values({ userId: 1, name: 'ci', keyHash: key.hash, keyPrefix: key.prefix, permissions })
      .returning();
    return { plaintext: key.plaintext, id: row!.id };
  }

  test('an API key signs in without recording its use', async () => {
    const key = await apiKey();
    await readOnly(true);
    expect((await resolveApiKey(key.plaintext))?.user.id).toBe(1);
    const [row] = await db.select().from(schema.apiKeys);
    expect(row!.lastUsedAt).toBeNull();
  });

  test('a connected app is answered without recording that it was seen', async () => {
    vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
    const key = await apiKey(['run:receive']);
    await db.insert(schema.runTargets).values({ userId: 1, apiKeyId: key.id, kind: 'desktop', deviceName: 'laptop' });
    await readOnly(true);
    const event = { node: { req: { headers: { 'x-api-key': key.plaintext } } }, context: {} };
    expect((await requireRunTarget(event as never)).target.lastSeenAt).toBeNull();
    const [target] = await db.select().from(schema.runTargets);
    expect(target!.lastSeenAt).toBeNull();
  });

  test('a provider sign-in opens a linked account as stored, and refuses to link or create one', async () => {
    await db.insert(schema.users).values([
      {
        id: 2,
        username: 'linked',
        password: '',
        role: 'member',
        name: 'Old',
        oauthProvider: 'github',
        oauthProviderId: '42',
      },
      { id: 3, username: 'blake', password: 'x', role: 'member', email: 'blake@example.com', emailVerified: true },
    ]);
    const profile = (providerId: string, email: string) => ({
      provider: 'github',
      providerId,
      email,
      emailVerified: true,
      name: 'New',
      avatar: '',
    });
    await readOnly(true);
    const signedIn = await findOrCreateOAuthUser(profile('42', 'linked@example.com'), db as never);
    expect(signedIn.id).toBe(2);
    const refusal = { statusCode: 409, data: { errorCode: 'READ_ONLY', oauthError: 'read-only' } };
    await expect(findOrCreateOAuthUser(profile('43', 'blake@example.com'), db as never)).rejects.toMatchObject(refusal);
    await expect(findOrCreateOAuthUser(profile('44', 'new@example.com'), db as never)).rejects.toMatchObject(refusal);
    await expect(linkProviderToUser(1, profile('45', 'avery@example.com'), db as never)).rejects.toMatchObject(refusal);
    const rows = await db.select().from(schema.users);
    expect(rows.map((user) => [user.id, user.name, user.oauthProviderId])).toEqual([
      [1, null, null],
      [2, 'Old', '42'],
      [3, null, null],
    ]);
  });

  test('an MCP client’s authorization lands on the consent page refused, and nothing is stored', async () => {
    await readOnly(true);
    expect(await startAuthorization(db as never, { client_id: 'any' }, 'http://localhost')).toEqual({
      kind: 'refused',
      error: 'read_only',
    });
    expect(await db.select().from(schema.oauthAuthorizationRequests)).toEqual([]);
  });

  test('a shard split stored is answered, and one that would be stored is refused', async () => {
    const tests = [
      { file: 'a.spec.ts', title: 'a' },
      { file: 'b.spec.ts', title: 'b' },
    ];
    const stored = parseShardSplitRequest({ commit: 'a'.repeat(40), shardTotal: 2, tests });
    const split = await getShardSplit(db as never, 1, stored);
    await readOnly(true);
    expect((await getShardSplit(db as never, 1, stored))?.shards).toEqual(split!.shards);
    const other = parseShardSplitRequest({ commit: 'b'.repeat(40), shardTotal: 2, tests });
    await expect(getShardSplit(db as never, 1, other)).rejects.toMatchObject({ statusCode: 409 });
    expect(await db.select().from(schema.shardSplits)).toHaveLength(1);
  });
});

describe('a write however the request spells its path, through the router', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  let server: http.Server;
  let port = 0;
  const reached: string[] = [];

  beforeAll(async () => {
    ({ db, close } = await openTempDb());
    state.db = db;
    const app = h3.createApp();
    app.use('/', h3.defineEventHandler(middleware as never));
    const router = h3.createRouter({ preemptive: true });
    const route = (name: string) =>
      h3.defineEventHandler(() => {
        reached.push(name);
        return { reached: name };
      });
    router.use('/api/test-runs/submit', route('submit'), 'post');
    router.use('/api/test-runs/:id/heartbeat', route('heartbeat'), 'post');
    router.use('/api/projects/:id', route('delete project'), 'delete');
    router.use('/oauth/token', route('token'), 'post');
    // The pages' renderer, which takes every path no route takes.
    router.use(
      '/**',
      h3.defineEventHandler(() => h3.createError({ statusCode: 404 })),
    );
    app.use('/', router.handler);
    server = http.createServer(h3.toNodeListener(app));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await close();
  });
  beforeEach(() => {
    reached.length = 0;
  });

  /** The status the server answers a request sent with `target` exactly as written. */
  function send(method: string, target: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () =>
        socket.write(
          `${method} ${target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        ),
      );
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(Number(data.split(' ')[1])));
      socket.on('error', reject);
    });
  }

  const SPELLINGS: [string, string][] = [
    ['POST', '/api/test-runs/submit'],
    ['POST', '/API/test-runs/submit'],
    ['POST', '/Api/Test-Runs/Submit'],
    ['POST', '//api/test-runs/submit'],
    ['POST', '/api//test-runs/submit'],
    ['POST', '/api/test-runs/submit/'],
    ['POST', '/api/test-runs/submit?x=1'],
    ['POST', '/api/test-runs/submit/?x=1'],
    ['POST', '/api/test-runs/submit#x'],
    ['POST', '/api/test-runs/12/heartbeat'],
    ['POST', '/api/test-runs/12//heartbeat'],
    ['POST', '/api/test-runs/12/heartbeat/'],
    ['post', '/api/test-runs/12/heartbeat'],
    ['DELETE', '/api/projects/4'],
    ['DELETE', '/api/projects/4/'],
    ['DELETE', '/api/projects/4?x=/api/operator/'],
    ['POST', '/oauth/token'],
    ['POST', '/oauth/token/'],
    ['POST', '//oauth/token'],
  ];

  test('reaches its route while the instance is writable', async () => {
    for (const [method, target] of SPELLINGS.slice(0, 1)) expect(await send(method, target)).toBe(200);
    expect(reached).toEqual(['submit']);
  });

  test('never reaches its route while the instance is read-only', async () => {
    await writeOperatorLimits(db as never, { readOnly: true });
    for (const [method, target] of SPELLINGS) {
      const status = await send(method, target);
      expect(reached, `${method} ${target} answered ${status}`).toEqual([]);
    }
    expect(await send('POST', '/api/test-runs/submit')).toBe(409);
  });
});

describe('the code that changes data in the background', () => {
  /** The plugins that change no data, each with what it does instead. Every other plugin asks `readOnlyNow` first. */
  const WRITES_NOTHING: Record<string, string> = {
    'auth-config': 'refuses to start without a session secret',
    'dashboard-widget-cache': 'drops cached answers in memory',
    'desktop-csp': 'sets a response header',
    'desktop-retention-sweep': 'runs the retention task, which asks itself',
    'desktop-runs': 'opens the desktop hub, which reads project names',
    'flake-profile-cache': 'drops cached profiles in memory',
    opentelemetry: 'traces requests',
    'pending-pr-status': 'follows a run’s tally in memory',
    'piwi-test-logs': 'attaches the server’s logs to the tests that caused them',
    'startup-checks': 'logs warnings',
  };

  const pluginsDir = join(APP_DIR, 'server/plugins');
  const pluginNames = readdirSync(pluginsDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.replace(/\.ts$/, ''));

  test('every scheduled task, every plugin that writes and the startup passes ask whether it is read-only', () => {
    const plugins = pluginNames
      .filter((name) => !(name in WRITES_NOTHING))
      .map((name) => join(pluginsDir, `${name}.ts`));
    for (const file of [...taskFiles(), ...plugins, join(APP_DIR, 'server/database/index.ts')]) {
      expect(readFileSync(file, 'utf8'), relative(APP_DIR, file)).toContain('readOnlyNow(');
    }
  });

  test('the plugins said to change no data exist', () => {
    expect(Object.keys(WRITES_NOTHING).filter((name) => !pluginNames.includes(name))).toEqual([]);
  });
});
