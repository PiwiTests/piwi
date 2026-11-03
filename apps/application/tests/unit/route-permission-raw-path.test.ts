import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as h3 from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { InstanceRole } from '#shared/permissions';
import { MAX_SERIAL_ID } from '#shared/route-id';
import { eq } from 'drizzle-orm';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, pending: null as null | { route: string; method: string } }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

const { handlersMeta } = await import('#nitro-internal-virtual/server-handlers-meta');
const { apiError } = await import('../../server/utils/api-error');
vi.stubGlobal('defineRouteMeta', (meta: unknown) => {
  (handlersMeta as unknown[]).push({ ...state.pending, meta });
});
vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false, authSecret: 'x'.repeat(48) }));
for (const name of [
  'getRequestHeader',
  'eventHandler',
  'defineEventHandler',
  'getRouterParam',
  'readBody',
  'getQuery',
  'getRequestURL',
  'sendRedirect',
  'setResponseHeader',
  'setResponseStatus',
]) {
  vi.stubGlobal(name, (h3 as Record<string, unknown>)[name]);
}
vi.stubGlobal('apiError', apiError);
process.env.PIWI_AUTH_ENABLED = 'true';

async function load(route: string, method: string, file: string) {
  state.pending = { route, method };
  return (await import(file)).default;
}
const putProjects = await load('/api/users/:id/projects', 'put', '../../server/api/users/[id]/projects.put.ts');
const deleteUser = await load('/api/users/:id', 'delete', '../../server/api/users/[id].delete.ts');
const patchUser = await load('/api/users/:id', 'patch', '../../server/api/users/[id].patch.ts');
const patchProject = await load('/api/projects/:id', 'patch', '../../server/api/projects/[id].patch.ts');
const idRoutes = [
  ['/api/tags/:id', 'patch', '../../server/api/tags/[id].patch.ts'],
  ['/api/channels/:id', 'delete', '../../server/api/channels/[id].delete.ts'],
  ['/api/subscriptions/:id', 'delete', '../../server/api/subscriptions/[id].delete.ts'],
  ['/api/users/:id/api-keys/:keyId', 'delete', '../../server/api/users/[id]/api-keys/[keyId].delete.ts'],
  ['/api/test-runs/:id/heartbeat', 'post', '../../server/api/test-runs/[id]/heartbeat.post.ts'],
  ['/api/integrations/connections/:id', 'get', '../../server/api/integrations/connections/[id].get.ts'],
  ['/api/bug-reports/:id/screenshots/:index', 'get', '../../server/api/bug-reports/[id]/screenshots/[index].get.ts'],
  ['/test-runs/:id/locate', 'get', '../../server/routes/test-runs/[id]/locate.get.ts'],
] as const;
const idRouteHandlers: Array<Awaited<ReturnType<typeof load>>> = [];
for (const [route, method, file] of idRoutes) idRouteHandlers.push(await load(route, method, file));
const { generateApiKey } = await import('../../server/utils/auth');
const { requireRouteId } = await import('../../server/utils/project-access');
let viewerKey = '';
let adminKey = '';

let db: TempDb;
let close: () => Promise<void>;
let server: http.Server;
let port = 0;
let memberKey = '';

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: 2, username: 'morgan', password: '', role: InstanceRole.MEMBER },
    { id: 3, username: 'blake', password: '', role: InstanceRole.ADMINISTRATOR },
  ]);
  await db.insert(schema.projects).values([{ id: 10, name: 'web' }]);
  const key = generateApiKey();
  memberKey = key.plaintext;
  await db.insert(schema.apiKeys).values({ userId: 2, name: 'ci', keyHash: key.hash, keyPrefix: key.prefix });
  await db.insert(schema.users).values({ id: 4, username: 'vic', password: '', role: InstanceRole.MEMBER });
  await db.insert(schema.roleBindings).values({ userId: 4, projectId: 10, role: 'viewer' });
  const vkey = generateApiKey();
  viewerKey = vkey.plaintext;
  await db.insert(schema.apiKeys).values({ userId: 4, name: 'ci', keyHash: vkey.hash, keyPrefix: vkey.prefix });
  const akey = generateApiKey();
  adminKey = akey.plaintext;
  await db.insert(schema.apiKeys).values({ userId: 1, name: 'ci', keyHash: akey.hash, keyPrefix: akey.prefix });

  const app = h3.createApp();
  const router = h3.createRouter({ preemptive: true });
  router.use('/api/users/:id/projects', putProjects, 'put');
  router.use('/api/users/:id', deleteUser, 'delete');
  router.use('/api/users/:id', patchUser, 'patch');
  router.use('/api/projects/:id', patchProject, 'patch');
  for (const [i, [route, method]] of idRoutes.entries()) router.use(route, idRouteHandlers[i], method);
  app.use('/', router.handler);
  server = http.createServer(h3.toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await close();
});

function raw(method: string, target: string, body = '', key = memberKey): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: localhost\r\nX-API-Key: ${key}\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      ),
    );
    let data = '';
    socket.on('data', (d) => (data += d));
    socket.on('end', () => resolve({ status: Number(data.split(' ')[1]), body: data.split('\r\n\r\n')[1] ?? '' }));
    socket.on('error', reject);
  });
}

describe('a route is held to its declared permission however the request spells its path', () => {
  test("a member cannot grant themselves a role on every project through a backslash or a '#'", async () => {
    const body = JSON.stringify({ allProjects: 'project_admin', projects: [] });
    expect((await raw('PUT', '/api/users/2/projects', body)).status).toBe(403);

    expect((await raw('PUT', '/api/users/2\\..\\..\\..\\..\\x/projects', body)).status).toBe(403);
    expect((await raw('PUT', '/api/users/2#/projects', body)).status).toBe(403);
    expect(await db.select().from(schema.roleBindings).where(eq(schema.roleBindings.userId, 2))).toEqual([]);
  });

  test('a member cannot delete an administrator through a backslash path', async () => {
    expect((await raw('DELETE', '/api/users/3')).status).toBe(403);
    expect((await raw('DELETE', '/api/users/3\\..\\..\\..\\x')).status).toBe(403);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, 3))).toHaveLength(1);
  });

  test('a viewer cannot change the settings of a project they only read through a backslash path', async () => {
    const body = JSON.stringify({ label: 'renamed' });
    expect((await raw('PATCH', '/api/projects/10', body, viewerKey)).status).toBe(403);
    // The route reads its id first, and a malformed id is refused before the permission check.
    expect([400, 403]).toContain((await raw('PATCH', '/api/projects/10\\..\\..\\..\\x', body, viewerKey)).status);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 10));
    expect(project?.label).not.toBe('renamed');
  });

  test('a role change through a backslash path is refused', async () => {
    const body = JSON.stringify({ role: 'administrator' });
    // The route reads its id first, and a malformed id is refused before the route's own check.
    expect([400, 403]).toContain((await raw('PATCH', '/api/users/2\\..\\..\\..\\x', body)).status);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, 2));
    expect(user?.role).toBe(InstanceRole.MEMBER);
  });
});

describe('a route id', () => {
  const idOf = (id: string) => requireRouteId({ context: { params: { id } } } as never, 'id', 'project ID');

  test('is a positive integer written plainly, up to the largest serial id', () => {
    expect(idOf('10')).toBe(10);
    expect(idOf(String(MAX_SERIAL_ID))).toBe(MAX_SERIAL_ID);
  });

  test.each(['10abc', '10\\..\\x', '010', '0', '-1', '1.5', '', String(MAX_SERIAL_ID + 1), '99999999999999999999'])(
    'refuses %j with 400',
    (id) => {
      expect(() => idOf(id)).toThrowError(expect.objectContaining({ statusCode: 400 }));
    },
  );
});

describe('a route reads its numeric params as plain positive integers', () => {
  test('no route reads a param with parseInt or Number', () => {
    const loose = /\b(?:parseInt|Number)\(\s*getRouterParam\(|\+\s*getRouterParam\(/;
    const offenders = ['server/api', 'server/routes'].flatMap((dir) => {
      const root = fileURLToPath(new URL(`../../${dir}/`, import.meta.url));
      return readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && loose.test(readFileSync(root + file, 'utf8')))
        .map((file) => `${dir}/${file}`);
    });
    expect(offenders).toEqual([]);
  });

  test.each([
    ['PATCH', '/api/tags/12abc'],
    ['PATCH', '/api/tags/012'],
    ['DELETE', '/api/channels/12abc'],
    ['DELETE', '/api/channels/012'],
    ['DELETE', '/api/subscriptions/12abc'],
    ['DELETE', '/api/subscriptions/012'],
    ['DELETE', '/api/users/1/api-keys/12abc'],
    ['DELETE', '/api/users/01/api-keys/1'],
    ['POST', '/api/test-runs/12abc/heartbeat'],
    ['POST', '/api/test-runs/012/heartbeat'],
    ['GET', '/api/integrations/connections/12abc'],
    ['GET', '/api/integrations/connections/012'],
    ['PATCH', `/api/tags/${MAX_SERIAL_ID + 1}`],
    ['POST', `/api/test-runs/${MAX_SERIAL_ID + 1}/heartbeat`],
    ['GET', '/api/bug-reports/1/screenshots/1abc'],
    ['GET', '/api/bug-reports/1/screenshots/01'],
  ])('%s %s is refused with 400', async (method, target) => {
    const answer = await raw(method, target, method === 'GET' ? '' : '{}', adminKey);
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ data: { errorCode: 'BAD_REQUEST' } });
  });

  test('an id at the largest serial id reaches the route, which finds no such row', async () => {
    expect((await raw('PATCH', `/api/tags/${MAX_SERIAL_ID}`, '{}', adminKey)).status).toBe(404);
  });

  test('a 0-based index takes 0', async () => {
    // Past the index, to the bug report it names, which does not exist.
    expect((await raw('GET', '/api/bug-reports/1/screenshots/0', '', adminKey)).status).toBe(404);
  });

  test.each(['12abc', '012'])('a locate link to run %j says it names no run', async (id) => {
    const answer = await raw('GET', `/test-runs/${id}/locate?file=a.spec.ts&title=pays`, '', adminKey);
    expect(answer.status).toBe(404);
    expect(answer.body).toContain('This link is missing the run');
  });
});
