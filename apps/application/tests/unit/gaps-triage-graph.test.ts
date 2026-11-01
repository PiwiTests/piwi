import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const {
  triageGap,
  listAcceptedUnwritten,
  listScenarioGaps,
  computeScenarioGaps,
  reopenExpiredSnoozes,
  upsertScenarioGaps,
} = await import('../../shared/handlers/scenario-gaps');
const { getFeatureGraph, getFeatureMap } = await import('../../server/utils/feature-graph');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'gaps-project' });
});

async function seedGap(overrides: Partial<typeof schema.scenarioGaps.$inferInsert> = {}) {
  await upsertScenarioGaps(
    db,
    1,
    [
      {
        detector: 'success-only',
        kind: 'gap',
        class: 'blind-spot',
        key: 'GET /api/cart',
        title: 'GET /api/cart: no error path under test',
        evidence: ['seen'],
        confidence: 0.5,
        factors: { churn: 0.5, age: 0.5, escapeHistory: 0.1, priority: 0.4 },
        score: 0.01,
      },
    ],
    {},
  );
  const [row] = await db.select({ id: schema.scenarioGaps.id }).from(schema.scenarioGaps).limit(1);
  if (Object.keys(overrides).length > 0) {
    await db.update(schema.scenarioGaps).set(overrides).where(eq(schema.scenarioGaps.id, row!.id));
  }
  return row!.id;
}

describe('triageGap', () => {
  test('accept marks accepted and stamps acceptedAt', async () => {
    const id = await seedGap();
    const result = await triageGap(db, 1, id, { verb: 'accept' });
    expect(result).toEqual({ status: 'accepted' });
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, id));
    expect(row!.status).toBe('accepted');
    expect(row!.acceptedAt).not.toBeNull();
  });

  test('snooze 1-week sets a future wake time', async () => {
    const id = await seedGap();
    await triageGap(db, 1, id, { verb: 'snooze', snooze: '1-week' });
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, id));
    expect(row!.status).toBe('snoozed');
    expect(row!.snoozedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  test('dismiss records the reason', async () => {
    const id = await seedGap();
    await triageGap(db, 1, id, { verb: 'dismiss', reason: 'not-worth-testing' });
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, id));
    expect(row!.status).toBe('dismissed');
    expect(row!.dismissReason).toBe('not-worth-testing');
  });

  test('covered-by closes the gap and writes a manual reaches edge', async () => {
    const id = await seedGap();
    await db.insert(schema.testCases).values({ id: 42, projectId: 1, title: 'covers cart', filePath: 'cart.spec.ts' });
    expect(await triageGap(db, 1, id, { verb: 'covered-by', coveringTestCaseId: 42 })).toEqual({ status: 'closed' });
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, id));
    expect(row!.status).toBe('closed');
    expect(row!.closedAt).not.toBeNull();
    expect(row!.coveredAt).not.toBeNull();
    const edges = await db
      .select()
      .from(schema.graphEdges)
      .where(and(eq(schema.graphEdges.kind, 'reaches'), eq(schema.graphEdges.origin, 'manual')));
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromKey).toBe('42');
    expect(edges[0]!.toKey).toBe('GET /api/cart');
  });

  test('a gap closed with covered-by stays closed when its detector raises it again', async () => {
    const id = await seedGap();
    await db.insert(schema.testCases).values({ id: 42, projectId: 1, title: 'covers cart', filePath: 'cart.spec.ts' });
    await triageGap(db, 1, id, { verb: 'covered-by', coveringTestCaseId: 42 });

    // The detector still sees no error path: the next recompute upserts the same gap.
    await seedGap();

    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, id));
    expect(row!.status).toBe('closed');
  });

  test('a covering test from another project is rejected and writes no edge', async () => {
    const id = await seedGap();
    await db.insert(schema.projects).values({ id: 2, name: 'other-project' });
    await db
      .insert(schema.testCases)
      .values({ id: 77, projectId: 2, title: 'someone else', filePath: 'other.spec.ts' });
    const result = await triageGap(db, 1, id, { verb: 'covered-by', coveringTestCaseId: 77 });
    expect(result).toEqual({ error: 'covering-test-not-found' });
    const edges = await db.select().from(schema.graphEdges).where(eq(schema.graphEdges.kind, 'reaches'));
    expect(edges).toHaveLength(0);
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, id));
    expect(row!.status).toBe('open'); // unchanged
  });

  test('a missing gap returns a gap-not-found error', async () => {
    expect(await triageGap(db, 1, 999, { verb: 'accept' })).toEqual({ error: 'gap-not-found' });
  });
});

describe('reopenExpiredSnoozes / listAcceptedUnwritten', () => {
  test('an expired snooze reopens; a future one does not', async () => {
    const past = await seedGap({ status: 'snoozed', snoozedUntil: new Date(Date.now() - 1000) });
    const future = await seedGapSecond({ status: 'snoozed', snoozedUntil: new Date(Date.now() + 100000) });
    const woken = await reopenExpiredSnoozes(db, 1);
    expect(woken).toBe(1);
    const [p] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, past));
    const [f] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, future));
    expect(p!.status).toBe('open');
    expect(f!.status).toBe('snoozed');
  });

  test('accepted-but-unwritten older than a week lists', async () => {
    await seedGap({ status: 'accepted', acceptedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    const rows = await listAcceptedUnwritten(db, [1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('accepted');
  });

  test('an accepted gap on a reached route stays in the queue: reaching the route is not testing its error path', async () => {
    await seedGap({ status: 'accepted', acceptedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '9',
      toKind: 'route',
      toKey: 'GET /api/cart',
      kind: 'reaches',
      branch: null,
      confidence: 1,
      lastSeenAt: new Date(),
    });
    expect(await listAcceptedUnwritten(db, [1])).toHaveLength(1);
  });

  test('an accepted gap a recompute closed, its test written, leaves the queue', async () => {
    await seedGap({ status: 'closed', acceptedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    expect(await listAcceptedUnwritten(db, [1])).toHaveLength(0);
  });

  test('an accepted finding, which never closes itself, is never in the queue', async () => {
    await seedGap({ status: 'accepted', kind: 'finding', acceptedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
    expect(await listAcceptedUnwritten(db, [1])).toHaveLength(0);
  });

  test('listScenarioGaps reopens an expired snooze before listing', async () => {
    await seedGap({ status: 'snoozed', snoozedUntil: new Date(Date.now() - 1000) });
    const open = await listScenarioGaps(db, 1, {}); // defaults to open only
    expect(open.map((g) => g.key)).toContain('GET /api/cart');
  });
});

describe('computeScenarioGaps snooze + accepted lifecycle', () => {
  test('an "until the node changes" snooze reopens only when the node\'s edge shape changes', async () => {
    // A finding on a route node with one incident edge, so it has a shape to fingerprint.
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/cart',
      origin: 'observed',
      lastSeenRunId: 5,
      lastSeenAt: new Date(),
    });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, title: 'reaches cart', filePath: 'cart.spec.ts' },
      { id: 2, projectId: 1, title: 'also reaches cart', filePath: 'cart2.spec.ts' },
    ]);
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '1',
      toKind: 'route',
      toKey: 'GET /api/cart',
      kind: 'reaches',
      confidence: 1,
      lastSeenAt: new Date(),
    });
    await upsertScenarioGaps(
      db,
      1,
      [
        {
          detector: 'not-handled', // not in the close list, so it survives the recompute
          kind: 'finding',
          class: 'unhandled',
          key: 'route:GET /api/cart',
          title: 'GET /api/cart: unhandled failure',
          evidence: ['x'],
          confidence: 1,
          factors: null as never,
          score: 0.5,
        },
      ],
      {},
    );
    const [gap] = await db
      .select({ id: schema.scenarioGaps.id })
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.detector, 'not-handled'));
    await triageGap(db, 1, gap!.id, { verb: 'snooze', snooze: 'until-node-changes' });
    let [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, gap!.id));
    expect(row!.status).toBe('snoozed');
    expect(row!.snoozedUntil).toBeNull();
    expect(row!.snoozedAtSignature).not.toBeNull();

    // Re-observing the node in a later run without changing its edges does not wake it.
    await db
      .update(schema.graphNodes)
      .set({ lastSeenRunId: 6 })
      .where(and(eq(schema.graphNodes.kind, 'route'), eq(schema.graphNodes.key, 'GET /api/cart')));
    await computeScenarioGaps(db, 1);
    [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, gap!.id));
    expect(row!.status).toBe('snoozed');

    // A second test now reaches the route — the node's edge shape changed, so it wakes.
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '2',
      toKind: 'route',
      toKey: 'GET /api/cart',
      kind: 'reaches',
      confidence: 1,
      lastSeenAt: new Date(),
    });
    await computeScenarioGaps(db, 1);
    [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, gap!.id));
    expect(row!.status).toBe('open');
    expect(row!.snoozedAtSignature).toBeNull();
  });

  test('an "until the node changes" snooze on a non-node subject falls back to a fixed length', async () => {
    // A test:-subject gap is not a trackable graph node, so it must not snooze forever.
    await upsertScenarioGaps(
      db,
      1,
      [
        {
          detector: 'orphan-test',
          kind: 'gap',
          class: 'fragile',
          key: 'test:42',
          title: 'orphan',
          evidence: ['x'],
          confidence: 0.4,
          factors: null as never,
          score: 0.1,
        },
      ],
      {},
    );
    const [gap] = await db
      .select({ id: schema.scenarioGaps.id })
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.detector, 'orphan-test'));
    await triageGap(db, 1, gap!.id, { verb: 'snooze', snooze: 'until-node-changes' });
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, gap!.id));
    expect(row!.status).toBe('snoozed');
    expect(row!.snoozedAtSignature).toBeNull();
    // A fixed wake time, not a snooze that could never wake.
    expect(row!.snoozedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  test('an accepted gap no longer detected closes so the inbox drains', async () => {
    await seedGap({ status: 'accepted', acceptedAt: new Date(Date.now() - 1000) });
    // No route stats seed the success-only detector, so the gap is not re-detected.
    await computeScenarioGaps(db, 1);
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.detector, 'success-only'));
    expect(row!.status).toBe('closed');
  });
});

// A second distinct gap (different detector/key) for the snooze test.
async function seedGapSecond(overrides: Partial<typeof schema.scenarioGaps.$inferInsert>) {
  await upsertScenarioGaps(
    db,
    1,
    [
      {
        detector: 'single-covering-test',
        kind: 'gap',
        class: 'fragile',
        key: 'route:POST /api/orders',
        title: 'Only one test reaches route POST /api/orders',
        evidence: ['x'],
        confidence: 0.5,
        factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
        score: 0.001,
      },
    ],
    {},
  );
  const [row] = await db
    .select({ id: schema.scenarioGaps.id })
    .from(schema.scenarioGaps)
    .where(eq(schema.scenarioGaps.detector, 'single-covering-test'));
  await db.update(schema.scenarioGaps).set(overrides).where(eq(schema.scenarioGaps.id, row!.id));
  return row!.id;
}

describe('getFeatureGraph', () => {
  beforeEach(async () => {
    const base = {
      projectId: 1,
      branch: null as string | null,
      confidence: 1,
      origin: 'observed' as const,
      lastSeenAt: new Date(),
    };
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'POST /api/orders', origin: 'observed', lastSeenAt: new Date() },
      { projectId: 1, kind: 'handler', key: 'src/api/orders.post.ts', origin: 'observed', lastSeenAt: new Date() },
      { projectId: 1, kind: 'dependency', key: 'payments-svc', origin: 'observed', lastSeenAt: new Date() },
    ]);
    await db.insert(schema.graphEdges).values([
      { ...base, fromKind: 'test', fromKey: '1', toKind: 'route', toKey: 'POST /api/orders', kind: 'reaches' },
      {
        ...base,
        fromKind: 'route',
        fromKey: 'POST /api/orders',
        toKind: 'handler',
        toKey: 'src/api/orders.post.ts',
        kind: 'handled-by',
        confidence: null,
      },
      {
        ...base,
        fromKind: 'handler',
        fromKey: 'src/api/orders.post.ts',
        toKind: 'dependency',
        toKey: 'payments-svc',
        kind: 'calls',
        confidence: null,
      },
    ]);
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, title: 'checkout happy path', filePath: 'a.spec.ts' });
  });

  test('walks outward to the requested depth and attaches tests', async () => {
    const graph = await getFeatureGraph(db, 1, { kind: 'route', key: 'POST /api/orders' }, 2);
    const keys = graph.nodes.map((n) => `${n.kind}:${n.key}`);
    expect(keys).toContain('route:POST /api/orders');
    expect(keys).toContain('handler:src/api/orders.post.ts');
    expect(keys).toContain('dependency:payments-svc');
    const route = graph.nodes.find((n) => n.kind === 'route');
    expect(route!.tests.map((t) => t.title)).toContain('checkout happy path');
  });

  test('depth 1 stops at the immediate neighbors', async () => {
    const graph = await getFeatureGraph(db, 1, { kind: 'route', key: 'POST /api/orders' }, 1);
    const keys = graph.nodes.map((n) => `${n.kind}:${n.key}`);
    expect(keys).toContain('handler:src/api/orders.post.ts');
    expect(keys).not.toContain('dependency:payments-svc');
  });

  test('depth is capped at six', async () => {
    const graph = await getFeatureGraph(db, 1, { kind: 'route', key: 'POST /api/orders' }, 99);
    expect(graph.depth).toBe(6);
  });

  test('a neighbor at the edge of the walk still carries its reaching tests', async () => {
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      branch: null,
      confidence: null,
      origin: 'observed',
      lastSeenAt: new Date(),
      fromKind: 'feature',
      fromKey: 'Checkout',
      toKind: 'route',
      toKey: 'POST /api/orders',
      kind: 'groups',
    });
    const graph = await getFeatureGraph(db, 1, { kind: 'feature', key: 'Checkout' }, 1);
    const route = graph.nodes.find((n) => n.kind === 'route');
    expect(route!.depth).toBe(1);
    expect(route!.tests.map((t) => t.title)).toEqual(['checkout happy path']);
    // The test endpoint itself is two hops away and stays out of a depth-one walk.
    expect(graph.nodes.map((n) => n.kind)).not.toContain('test');
  });
});

describe('getFeatureMap', () => {
  const edge = (fromKind: string, fromKey: string, toKind: string, toKey: string, kind: string) => ({
    projectId: 1,
    branch: null as string | null,
    confidence: null as number | null,
    origin: 'observed' as const,
    lastSeenAt: new Date(),
    fromKind,
    fromKey,
    toKind,
    toKey,
    kind,
  });

  beforeEach(async () => {
    await db.insert(schema.graphEdges).values([
      // Checkout groups two routes and a page; Catalog groups one route it shares with Checkout.
      edge('feature', 'Checkout', 'route', 'POST /api/orders', 'groups'),
      edge('feature', 'Checkout', 'route', 'GET /api/cart', 'groups'),
      edge('feature', 'Checkout', 'page', '/checkout', 'groups'),
      edge('feature', 'Catalog', 'route', 'GET /api/cart', 'groups'),
      edge('feature', 'Catalog', 'control', 'button:Add to cart', 'groups'),
      // Tests reaching the nodes: 1 and 2 reach Checkout's routes, 2 also reaches the shared one.
      edge('test', '1', 'route', 'POST /api/orders', 'reaches'),
      edge('test', '2', 'route', 'GET /api/cart', 'reaches'),
      edge('test', '2', 'page', '/checkout', 'reaches'),
      // A branch row never counts.
      { ...edge('feature', 'Branch-only', 'route', 'GET /api/x', 'groups'), branch: 'pr-1' },
    ]);
    await upsertScenarioGaps(
      db,
      1,
      [
        {
          detector: 'success-only',
          kind: 'gap',
          class: 'blind-spot',
          key: 'GET /api/cart',
          title: 'GET /api/cart: no error path under test',
          evidence: ['seen'],
          confidence: 0.5,
          factors: { churn: 0.5, age: 0.5, escapeHistory: 0.1, priority: 0.4 },
          score: 0.01,
        },
        {
          detector: 'not-handled',
          kind: 'finding',
          class: 'unhandled',
          key: 'route:POST /api/orders',
          title: 'POST /api/orders: unhandled failure',
          evidence: ['x'],
          confidence: 1,
          factors: null as never,
          score: 0.5,
        },
        {
          detector: 'single-covering-test',
          kind: 'gap',
          class: 'fragile',
          key: 'route:GET /api/orphan',
          title: 'Only one test reaches route GET /api/orphan',
          evidence: ['x'],
          confidence: 0.5,
          factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
          score: 0.001,
        },
      ],
      {},
    );
  });

  test('folds members, tests and open gaps per feature, worst class first', async () => {
    const map = await getFeatureMap(db, 1);
    expect(map.features.map((f) => f.key)).toEqual(['Checkout', 'Catalog']);
    const checkout = map.features[0]!;
    expect(checkout.members).toEqual({ routes: 2, pages: 1, controls: 0, inferred: 0 });
    expect(checkout.tests).toBe(2);
    // The shared route's gap counts once, under the feature the list files it under (first by name).
    expect(checkout.gaps).toEqual({ unhandled: 1 });
    expect(checkout.worstClass).toBe('unhandled');
    const catalog = map.features[1]!;
    expect(catalog.members).toEqual({ routes: 1, pages: 0, controls: 1, inferred: 0 });
    expect(catalog.tests).toBe(1);
    expect(catalog.gaps).toEqual({ 'blind-spot': 1 });
    expect(catalog.worstClass).toBe('blind-spot');
  });

  test('links features by the nodes they share and reports the ungrouped gaps', async () => {
    const map = await getFeatureMap(db, 1);
    expect(map.links).toEqual([{ from: 'Catalog', to: 'Checkout', weight: 1 }]);
    expect(map.ungrouped).toEqual({ gaps: { fragile: 1 }, worstClass: 'fragile' });
  });

  test('a snoozed gap no longer counts', async () => {
    const [orders] = await db
      .select({ id: schema.scenarioGaps.id })
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.detector, 'not-handled'));
    await triageGap(db, 1, orders!.id, { verb: 'snooze', snooze: '1-week' });
    const map = await getFeatureMap(db, 1);
    const checkout = map.features.find((f) => f.key === 'Checkout')!;
    expect(checkout.worstClass).toBeNull();
    expect(checkout.gaps).toEqual({});
  });

  test('a muted detector neither counts nor colors a feature', async () => {
    // Twenty gaps dismissed as wrong mute success-only on the project.
    await db.insert(schema.scenarioGaps).values(
      Array.from({ length: 20 }, (_, i) => ({
        projectId: 1,
        detector: 'success-only',
        class: 'blind-spot',
        key: `GET /api/noise-${i}`,
        title: 't',
        status: 'dismissed',
        dismissReason: 'wrong',
      })),
    );
    const map = await getFeatureMap(db, 1);
    const catalog = map.features.find((f) => f.key === 'Catalog')!;
    expect(catalog.gaps).toEqual({});
    expect(catalog.worstClass).toBeNull();
  });

  test('an empty project maps to no features', async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'empty' });
    expect(await getFeatureMap(db, 2)).toEqual({
      features: [],
      links: [],
      ungrouped: { gaps: {}, worstClass: null },
      shared: { nodes: 0, gaps: {}, worstClass: null },
    });
  });

  test('a hub adds no member, test, gap or link to the features grouping it, and counts under shared', async () => {
    await db
      .update(schema.graphEdges)
      .set({ evidence: { hub: true } })
      .where(and(eq(schema.graphEdges.kind, 'groups'), eq(schema.graphEdges.toKey, 'GET /api/cart')));
    const map = await getFeatureMap(db, 1);
    const checkout = map.features.find((f) => f.key === 'Checkout')!;
    expect(checkout.members).toEqual({ routes: 1, pages: 1, controls: 0, inferred: 0 });
    expect(checkout.gaps).toEqual({ unhandled: 1 });
    expect(map.links).toEqual([]);
    expect(map.shared).toEqual({ nodes: 1, gaps: { 'blind-spot': 1 }, worstClass: 'blind-spot' });
    const listed = await listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(listed.map((g) => ({ feature: g.feature, hub: g.hub }))).toEqual([{ feature: null, hub: true }]);
  });

  test('a gap sits under the feature reaching its node before one that only infers it', async () => {
    await db.insert(schema.graphEdges).values({
      ...edge('feature', 'Accounts', 'route', 'POST /api/orders', 'groups'),
      origin: 'inferred' as never,
      confidence: 0.6,
      evidence: { via: 'path' },
    });
    const listed = await listScenarioGaps(db, 1, { kind: 'finding' });
    expect(listed.map((g) => g.feature)).toEqual(['Checkout']);
  });
});
