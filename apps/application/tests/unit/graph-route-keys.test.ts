/**
 * Route keys without the query: the key builder drops it, and the one-time
 * rewrite merges what older versions split by it.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { routeNodeKey } from '../../shared/graph';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const {
  rewriteQueryRouteKeys,
  rewriteQueryRouteKeysOnce,
  gapKeyWithoutRouteQuery,
  signatureWithoutRouteQuery,
  ROUTE_KEYS_WITHOUT_QUERY_SETTING,
} = await import('../../server/utils/graph-route-keys');
const { collectRunGraphReaches } = await import('../../server/utils/graph-ingest');

const PAGE = 'GET /api/users?page=%3Credacted%3E';
const ROLE = 'GET /api/users?role=%3Credacted%3E';

describe('routeNodeKey', () => {
  test('one endpoint is one key, whatever query a call passes', () => {
    expect(routeNodeKey('get', '/api/users?page=%3Credacted%3E')).toBe('GET /api/users');
    expect(routeNodeKey('GET', '/api/users')).toBe('GET /api/users');
  });

  test('two calls that differ only in their query reach one route node', () => {
    const graph = collectRunGraphReaches(
      [{ testCaseId: 1, pageState: null, locatorPages: null }],
      [
        {
          items: [
            { method: 'GET', normalizedUrl: '/api/users?page=%3Credacted%3E', status: 200 },
            { method: 'GET', normalizedUrl: '/api/users?role=%3Credacted%3E', status: 200 },
          ],
        },
      ],
      { origins: new Set() },
    );
    expect(graph[0]!.routes.map((r) => routeNodeKey(r.method, r.normalizedUrl))).toEqual(['GET /api/users']);
  });
});

describe('gapKeyWithoutRouteQuery', () => {
  test('takes the query out of the route a gap key names, and leaves other keys alone', () => {
    expect(gapKeyWithoutRouteQuery(PAGE)).toBe('GET /api/users');
    expect(gapKeyWithoutRouteQuery(`route:${PAGE}`)).toBe('route:GET /api/users');
    expect(gapKeyWithoutRouteQuery(`route:${PAGE}:500`)).toBe('route:GET /api/users:500');
    expect(gapKeyWithoutRouteQuery(`dependency:postgres @ ${PAGE}`)).toBe('dependency:postgres @ GET /api/users');
    expect(gapKeyWithoutRouteQuery('control:button:Need help?')).toBe('control:button:Need help?');
  });
});

describe('signatureWithoutRouteQuery', () => {
  test('rewrites route endpoints and counts the lines the merge made equal once', () => {
    const before = [
      '3',
      `loads|page:/users>route:${PAGE}|`,
      `loads|page:/users>route:${ROLE}|`,
      'contains|page:/users>control:button:Need help?|',
    ].join('\n');
    expect(signatureWithoutRouteQuery(before)).toBe(
      ['2', 'contains|page:/users>control:button:Need help?|', 'loads|page:/users>route:GET /api/users|'].join('\n'),
    );
  });
});

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'pages' },
    { id: 2, projectId: 1, filePath: 'a.spec.ts', title: 'filters' },
  ]);
});

describe('rewriteQueryRouteKeys', () => {
  test('merges the nodes and edges a query split, keeping the earliest and latest sightings', async () => {
    const [declared] = await db
      .insert(schema.graphNodes)
      .values({
        projectId: 1,
        kind: 'route',
        key: 'GET /api/users',
        origin: 'openapi',
        attrs: { declared: true, responses: [200, 404] },
        lastSeenAt: new Date(1000),
      })
      .returning();
    const [page] = await db
      .insert(schema.graphNodes)
      .values({
        projectId: 1,
        kind: 'route',
        key: PAGE,
        firstSeenRunId: 3,
        lastSeenRunId: 9,
        lastSeenAt: new Date(9000),
      })
      .returning();
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: ROLE, firstSeenRunId: 2, lastSeenRunId: 5, lastSeenAt: new Date(5000) },
      { projectId: 1, kind: 'route', key: 'POST /api/export?format=%3Credacted%3E', lastSeenAt: new Date() },
      { projectId: 1, kind: 'route', key: PAGE, branch: 'feature/x', lastSeenAt: new Date() },
    ]);
    const edge = (fromKey: string, toKey: string, lastSeenAt: number) => ({
      projectId: 1,
      fromKind: 'test',
      fromKey,
      toKind: 'route',
      toKey,
      kind: 'reaches',
      firstSeenRunId: lastSeenAt / 1000,
      lastSeenRunId: lastSeenAt / 1000,
      lastSeenAt: new Date(lastSeenAt),
    });
    await db.insert(schema.graphEdges).values([edge('1', PAGE, 9000), edge('1', ROLE, 4000), edge('2', ROLE, 5000)]);
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '1',
      toKind: 'dependency',
      toKey: 'postgres',
      kind: 'checks',
      evidence: { route: PAGE, outcome: 'noticed' },
      lastSeenAt: new Date(),
    });
    await db.insert(schema.probes).values({
      projectId: 1,
      testCaseId: 1,
      nodeId: page!.id,
      routeKey: PAGE,
      fault: 'status-500',
      outcome: 'noticed',
    });

    await rewriteQueryRouteKeys(db as never);

    const nodes = await db.select().from(schema.graphNodes).where(eq(schema.graphNodes.kind, 'route'));
    expect(nodes.map((n) => [n.key, n.branch]).sort()).toEqual([
      ['GET /api/users', null],
      ['GET /api/users', 'feature/x'],
      ['POST /api/export', null],
    ]);
    const users = nodes.find((n) => n.key === 'GET /api/users' && n.branch == null)!;
    expect(users).toMatchObject({
      id: declared!.id,
      origin: 'openapi',
      attrs: { declared: true, responses: [200, 404] },
      firstSeenRunId: 2,
      lastSeenRunId: 9,
    });
    expect(users.lastSeenAt.getTime()).toBe(9000);

    const edges = await db.select().from(schema.graphEdges);
    expect(
      edges
        .filter((e) => e.kind === 'reaches')
        .map((e) => [e.fromKey, e.toKey, e.firstSeenRunId, e.lastSeenRunId])
        .sort(),
    ).toEqual([
      ['1', 'GET /api/users', 4, 9],
      ['2', 'GET /api/users', 5, 5],
    ]);
    expect(edges.find((e) => e.kind === 'checks')!.evidence).toEqual({ route: 'GET /api/users', outcome: 'noticed' });
    const [probe] = await db.select().from(schema.probes);
    expect(probe).toMatchObject({ routeKey: 'GET /api/users', nodeId: declared!.id });
  });

  test('a probe whose key collides keeps the newer outcome', async () => {
    const probe = (routeKey: string, outcome: string, probedAt: number) => ({
      projectId: 1,
      testCaseId: 1,
      routeKey,
      fault: 'status-500',
      outcome,
      probedAt: new Date(probedAt),
    });
    await db
      .insert(schema.probes)
      .values([
        probe('GET /api/users', 'not-noticed', 1000),
        probe(PAGE, 'noticed', 5000),
        probe(ROLE, 'inconclusive', 3000),
      ]);
    await rewriteQueryRouteKeys(db as never);
    const rows = await db.select().from(schema.probes);
    expect(rows.map((r) => [r.routeKey, r.outcome])).toEqual([['GET /api/users', 'noticed']]);
  });

  test('the gap ledger keeps every verdict: one row takes the new key, the others close or stay dismissed', async () => {
    const gap = (over: Partial<typeof schema.scenarioGaps.$inferInsert>) => ({
      projectId: 1,
      kind: 'gap',
      class: 'blind-spot',
      title: 't',
      updatedAt: new Date(1000),
      ...over,
    });
    await db.insert(schema.scenarioGaps).values([
      gap({ detector: 'success-only', key: PAGE, status: 'open' }),
      gap({ detector: 'success-only', key: ROLE, status: 'dismissed', dismissReason: 'not-worth-testing' }),
      gap({ detector: 'single-covering-test', key: `route:${PAGE}`, status: 'open' }),
      gap({ detector: 'single-covering-test', key: 'route:GET /api/users', status: 'accepted' }),
      gap({ detector: 'not-handled', key: `dependency:postgres @ ${ROLE}`, status: 'open', kind: 'finding' }),
      gap({ detector: 'control-nobody-exercises', key: 'control:button:Need help?', status: 'open' }),
      gap({
        detector: 'reachable-unvisited',
        key: 'page:/users',
        status: 'snoozed',
        snoozedAtSignature: `1\nloads|page:/users>route:${PAGE}|`,
      }),
    ]);

    await rewriteQueryRouteKeys(db as never);
    const rows = await db.select().from(schema.scenarioGaps);
    const view = rows.map((r) => [r.detector, r.key, r.status]).sort();
    expect(view).toEqual(
      [
        // The dismissal is the most deliberate verdict, so it takes the new key; the open duplicate closes.
        ['success-only', 'GET /api/users', 'dismissed'],
        ['success-only', PAGE, 'closed'],
        // A row already holds the new key, so the duplicate closes under its old one.
        ['single-covering-test', 'route:GET /api/users', 'accepted'],
        ['single-covering-test', `route:${PAGE}`, 'closed'],
        ['not-handled', 'dependency:postgres @ GET /api/users', 'open'],
        ['control-nobody-exercises', 'control:button:Need help?', 'open'],
        ['reachable-unvisited', 'page:/users', 'snoozed'],
      ].sort(),
    );
    expect(rows.find((r) => r.key === PAGE)!.closedByRunId).toBeNull();
    expect(rows.find((r) => r.key === 'page:/users')!.snoozedAtSignature).toBe(
      '1\nloads|page:/users>route:GET /api/users|',
    );
  });

  test('a closed row holding the new key gives it up to a dismissed duplicate, so the verdict survives', async () => {
    const gap = (key: string, status: string, updatedAt: number) => ({
      projectId: 1,
      kind: 'gap',
      detector: 'success-only',
      class: 'blind-spot',
      title: 't',
      key,
      status,
      updatedAt: new Date(updatedAt),
    });
    await db
      .insert(schema.scenarioGaps)
      .values([gap('GET /api/users', 'closed', 3000), gap(PAGE, 'dismissed', 1000), gap(ROLE, 'accepted', 2000)]);
    await rewriteQueryRouteKeys(db as never);
    const rows = await db.select().from(schema.scenarioGaps);
    expect(rows.map((r) => [r.key, r.status]).sort()).toEqual(
      [
        ['GET /api/users', 'dismissed'],
        [PAGE, 'closed'],
        [ROLE, 'closed'],
      ].sort(),
    );
  });

  test('runs once per instance, and a process finding a fresh claim leaves it alone', async () => {
    await db.insert(schema.graphNodes).values({ projectId: 1, kind: 'route', key: PAGE, lastSeenAt: new Date() });
    expect(await rewriteQueryRouteKeysOnce(db as never)).toMatchObject({ nodes: 1 });
    await db.insert(schema.graphNodes).values({ projectId: 1, kind: 'route', key: ROLE, lastSeenAt: new Date() });
    expect(await rewriteQueryRouteKeysOnce(db as never)).toBeNull();

    // Another process is running it: a fresh claim is left alone, a stale one is taken over.
    await db
      .update(schema.appSettings)
      .set({ value: { state: 'running', at: 'x' } as never, updatedAt: new Date() })
      .where(eq(schema.appSettings.key, ROUTE_KEYS_WITHOUT_QUERY_SETTING));
    expect(await rewriteQueryRouteKeysOnce(db as never)).toBeNull();
    await db
      .update(schema.appSettings)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(schema.appSettings.key, ROUTE_KEYS_WITHOUT_QUERY_SETTING));
    expect(await rewriteQueryRouteKeysOnce(db as never)).toMatchObject({ nodes: 1 });
  });
});
