/**
 * A page load is its page's own node: the route nodes that page loads alone
 * wrote are retired once per instance, with their edges.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { retirePageLoadRoutes, retirePageLoadRoutesOnce, PAGE_LOAD_ROUTES_RETIRED_SETTING } =
  await import('../../server/utils/graph-page-loads');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p', defaultBranch: 'main' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
  await db.insert(schema.testCases).values({ id: 7, projectId: 1, filePath: 'a.spec.ts', title: 'opens settings' });
  await db.insert(schema.testRunsCases).values({ id: 1, testRunId: 1, testCaseId: 7, status: 'passed' });
});

async function request(method: string, path: string, resourceType: string | null) {
  await db.insert(schema.networkRequests).values({
    testRunsCaseId: 1,
    testRunId: 1,
    method,
    url: `https://app.test${path}`,
    normalizedUrl: path,
    status: 200,
    resourceType,
  });
}

async function route(key: string, origin: string, branch: string | null = null) {
  await db
    .insert(schema.graphNodes)
    .values({ projectId: 1, kind: 'route', key, origin, branch, lastSeenAt: new Date() });
}

async function reaches(key: string) {
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    fromKind: 'test',
    fromKey: '7',
    toKind: 'route',
    toKey: key,
    kind: 'reaches',
    lastSeenAt: new Date(),
  });
}

const liveRoutes = async () =>
  (
    await db
      .select({ key: schema.graphNodes.key })
      .from(schema.graphNodes)
      .where(and(eq(schema.graphNodes.kind, 'route'), isNull(schema.graphNodes.prunedAt)))
  )
    .map((n) => n.key)
    .sort();

describe('retirePageLoadRoutes', () => {
  test('prunes a route only page loads reached, on every branch, and drops its edges', async () => {
    await request('GET', '/settings', 'document');
    await request('GET', '/api/settings', 'fetch');
    await route('GET /settings', 'observed');
    await route('GET /settings', 'observed', 'feature/x');
    await route('GET /api/settings', 'observed');
    await reaches('GET /settings');
    await reaches('GET /api/settings');
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'route',
      fromKey: 'GET /settings',
      toKind: 'handler',
      toKey: 'server/routes/settings.ts',
      kind: 'handled-by',
      lastSeenAt: new Date(),
    });

    expect(await retirePageLoadRoutes(db as never)).toEqual({ nodes: 2, edges: 2 });
    expect(await liveRoutes()).toEqual(['GET /api/settings']);
    const edges = await db.select({ toKey: schema.graphEdges.toKey }).from(schema.graphEdges);
    expect(edges.map((e) => e.toKey)).toEqual(['GET /api/settings']);
  });

  test('keeps a route a call also reached, and a declared route whatever reached it', async () => {
    await request('GET', '/users', 'document');
    await request('GET', '/users', 'xhr');
    await request('GET', '/docs', 'document');
    await route('GET /users', 'observed');
    await route('GET /docs', 'openapi');

    expect(await retirePageLoadRoutes(db as never)).toEqual({ nodes: 0, edges: 0 });
    expect(await liveRoutes()).toEqual(['GET /docs', 'GET /users']);
  });

  test('runs once per instance', async () => {
    await request('GET', '/settings', 'document');
    await route('GET /settings', 'observed');
    expect(await retirePageLoadRoutesOnce(db as never)).toEqual({ nodes: 1, edges: 0 });
    expect(await retirePageLoadRoutesOnce(db as never)).toBeNull();
    const [setting] = await db
      .select({ value: schema.appSettings.value })
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, PAGE_LOAD_ROUTES_RETIRED_SETTING));
    expect(setting!.value).toMatchObject({ state: 'done' });
  });
});
