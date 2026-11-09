import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getMapHealth } = await import('../../shared/handlers/map-health');

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'p' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'one' },
    { id: 2, projectId: 1, filePath: 'a.spec.ts', title: 'two' },
  ]);
});

const edge = (fromKind: string, fromKey: string, kind: string, toKind: string, toKey: string, branch?: string) => ({
  projectId: 1,
  fromKind,
  fromKey,
  kind,
  toKind,
  toKey,
  branch: branch ?? null,
  lastSeenAt: new Date(),
});

describe('getMapHealth', () => {
  test('a new project has nothing to measure and every input missing', async () => {
    const rows = await getMapHealth(db as never, 1);
    expect(rows.map((r) => [r.id, r.have, r.of])).toEqual([
      ['inventory', 0, 0],
      ['locator-pages', 0, 0],
      ['handlers', 0, 0],
      ['probes', 0, 0],
      ['declared', 0, null],
      ['changes', 0, null],
      ['catalog', 0, null],
    ]);
    expect(rows.find((r) => r.id === 'inventory')!.wakes).toContain('control-nobody-exercises');
  });

  test('counts each input against what it could hold, on the default branch only', async () => {
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/users' },
      { projectId: 1, kind: 'page', key: '/reports' },
      { projectId: 1, kind: 'page', key: '/gone', prunedAt: new Date() },
      { projectId: 1, kind: 'route', key: 'GET /api/users' },
      { projectId: 1, kind: 'route', key: 'GET /api/reports' },
      { projectId: 1, kind: 'route', key: 'GET /api/audit', origin: 'openapi' },
      { projectId: 1, kind: 'page', key: '/billing', origin: 'manifest' },
      { projectId: 1, kind: 'page', key: '/users', branch: 'feature/x' },
      { projectId: 2, kind: 'route', key: 'GET /api/other' },
    ]);
    await db.insert(schema.graphEdges).values([
      edge('test', '1', 'reaches', 'page', '/users'),
      edge('test', '2', 'reaches', 'page', '/reports'),
      edge('test', '1', 'reaches', 'page', '/gone'),
      edge('page', '/users', 'contains', 'control', 'button:Invite'),
      edge('page', '/reports', 'contains', 'control', 'button:Export', 'feature/x'),
      edge('test', '1', 'reaches', 'route', 'GET /api/users'),
      edge('test', '2', 'reaches', 'route', 'GET /api/reports'),
      edge('route', 'GET /api/users', 'handled-by', 'handler', 'server/api/users.get.ts'),
      {
        ...edge('test', '1', 'checks', 'route', 'GET /api/users'),
        evidence: { outcome: 'noticed', fault: 'empty-body' },
      },
      // A probe that decided nothing does not count the route as probed.
      {
        ...edge('test', '2', 'checks', 'route', 'GET /api/reports'),
        evidence: { outcome: 'inconclusive', fault: 'status-500' },
      },
      edge('commit', 'abc', 'changes', 'file', 'server/api/users.get.ts'),
      edge('commit', 'abc', 'changes', 'file', 'server/api/reports.get.ts'),
      edge('commit', 'def', 'changes', 'file', 'server/api/users.get.ts', 'feature/x'),
    ]);
    const use = (testCaseId: number, page: string, branch = '') => ({
      projectId: 1,
      testCaseId,
      locator: 'getByRole("table")',
      target: 'getByRole("table")',
      action: 'click',
      browserName: 'chromium',
      callSite: `a.spec.ts:${testCaseId}:1`,
      page,
      branch,
      lastSeenAt: new Date(),
    });
    await db.insert(schema.locatorUsages).values([use(1, '/users'), use(2, ''), use(2, '/reports', 'feature/x')]);
    const fn = (name: string, kind: string) => ({
      projectId: 1,
      name,
      kind,
      module: './pages/UsersPage',
      params: '[]',
      steps: '[]',
      paramSources: '[]',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(schema.testFunctions)
      .values([fn('invite', 'page-object-method'), fn('signIn', 'helper'), fn('admin', 'fixture')]);

    const rows = await getMapHealth(db as never, 1);
    expect(rows.map((r) => [r.id, r.have, r.of])).toEqual([
      ['inventory', 1, 2],
      ['locator-pages', 1, 2],
      ['handlers', 1, 2],
      ['probes', 1, 2],
      ['declared', 2, null],
      ['changes', 1, null],
      ['catalog', 2, null],
    ]);
  });
});
