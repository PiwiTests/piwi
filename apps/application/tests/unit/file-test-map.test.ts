import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

delete process.env.PIWI_DATABASE_URL;
const { getFileTestMap } = await import('../../server/utils/feature-graph');

let db: ReturnType<typeof drizzle<typeof schema>>;
let clock = 0;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'file-test-map' });
  clock = 0;
});

async function node(kind: string, key: string) {
  await db.insert(schema.graphNodes).values({ projectId: 1, kind, key, lastSeenAt: new Date(++clock) });
}

async function edge(kind: string, from: [string, string], to: [string, string]) {
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    kind,
    fromKind: from[0],
    fromKey: from[1],
    toKind: to[0],
    toKey: to[1],
    confidence: 1,
    lastSeenAt: new Date(++clock),
  });
}

async function gap(detector: string, key: string, title: string, score: number, status = 'open') {
  await db
    .insert(schema.scenarioGaps)
    .values({ projectId: 1, detector, class: 'blind-spot', key, title, score, status });
}

describe('getFileTestMap', () => {
  test('names a handler file’s node and the routes it serves, each with its tests and open gaps', async () => {
    await node('handler', 'api/Users/UsersEndpoints.cs');
    await node('route', 'GET /api/users');
    await node('route', 'DELETE /api/users/:id');
    await edge('handled-by', ['route', 'GET /api/users'], ['handler', 'api/Users/UsersEndpoints.cs']);
    await edge('handled-by', ['route', 'DELETE /api/users/:id'], ['handler', 'api/Users/UsersEndpoints.cs']);
    await edge('reaches', ['test', '1'], ['route', 'GET /api/users']);
    await edge('reaches', ['test', '2'], ['route', 'GET /api/users']);
    await gap('success-only', 'GET /api/users', 'GET /api/users: no error path under test', 0.2);
    await gap('declared-never-hit', 'route:DELETE /api/users/:id', 'DELETE /api/users/:id is never hit', 0.4);
    await gap('declared-never-hit', 'route:POST /api/orders', 'POST /api/orders is never hit', 0.9);
    await gap('single-covering-test', 'route:GET /api/users', 'a dismissed one', 0.5, 'dismissed');

    const map = await getFileTestMap(db, 1, 'api/Users/UsersEndpoints.cs');

    expect(map.nodes.map((n) => [n.kind, n.key, n.via, n.tests, n.openGaps])).toEqual([
      ['route', 'DELETE /api/users/:id', 'handled-by', 0, 1],
      ['route', 'GET /api/users', 'handled-by', 2, 1],
      ['handler', 'api/Users/UsersEndpoints.cs', 'node', 2, 0],
    ]);
    expect(map.nodes[1]!.gaps.map((g) => g.title)).toEqual(['GET /api/users: no error path under test']);
  });

  test('maps a page file by its file name, with the gaps of the controls the page contains', async () => {
    await node('page', '/orders/:id');
    await node('control', 'button:Refund');
    await edge('contains', ['page', '/orders/:id'], ['control', 'button:Refund']);
    await edge('reaches', ['test', '3'], ['page', '/orders/:id']);
    await gap('control-nobody-exercises', 'control:button:Refund', 'No test clicks Refund', 0.3);

    const map = await getFileTestMap(db, 1, 'app/pages/orders/[id].vue');

    expect(map.nodes).toMatchObject([
      {
        kind: 'page',
        key: '/orders/:id',
        via: 'convention',
        tests: 1,
        openGaps: 1,
        gaps: [{ title: 'No test clicks Refund' }],
      },
    ]);
  });

  test('lists a changed file’s own gap on its file node, matched by path suffix', async () => {
    await gap('changed-unreached', 'src/lib/cart.ts', 'src/lib/cart.ts changed but not reached', 0.6);

    const map = await getFileTestMap(db, 1, 'apps/web/src/lib/cart.ts');

    expect(map.nodes).toMatchObject([{ kind: 'file', key: 'src/lib/cart.ts', via: 'node', openGaps: 1 }]);
  });

  test('prefers the file’s own path to another file ending with it, and counts each handler’s own routes', async () => {
    await node('handler', 'Api/Users/UsersEndpoints.cs');
    await node('handler', 'Admin/Api/Users/UsersEndpoints.cs');
    await node('route', 'GET /api/users');
    await node('route', 'GET /admin/api/users');
    await edge('handled-by', ['route', 'GET /api/users'], ['handler', 'Api/Users/UsersEndpoints.cs']);
    await edge('handled-by', ['route', 'GET /admin/api/users'], ['handler', 'Admin/Api/Users/UsersEndpoints.cs']);
    await edge('reaches', ['test', '1'], ['route', 'GET /api/users']);
    await edge('reaches', ['test', '2'], ['route', 'GET /admin/api/users']);
    await edge('reaches', ['test', '3'], ['route', 'GET /admin/api/users']);

    const map = await getFileTestMap(db, 1, 'Admin/Api/Users/UsersEndpoints.cs');

    expect(map.nodes.map((n) => [n.kind, n.key, n.tests])).toEqual([
      ['route', 'GET /admin/api/users', 2],
      ['handler', 'Admin/Api/Users/UsersEndpoints.cs', 2],
    ]);
  });

  test('is empty for a file the Test Map does not hold', async () => {
    await node('route', 'GET /api/users');
    expect(await getFileTestMap(db, 1, 'src/utils/format.ts')).toEqual({ path: 'src/utils/format.ts', nodes: [] });
  });
});
