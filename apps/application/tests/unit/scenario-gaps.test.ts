import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { MCP_TOOLS } from '../../server/utils/mcp/tools';
import { ADMIN_ACCESS } from '#shared/permissions';

delete process.env.PIWI_DATABASE_URL;
const gaps = await import('../../shared/handlers/scenario-gaps');
const { runOrigin } = await import('../../shared/run-eligibility');

const mcpCtx = { user: null, access: ADMIN_ACCESS, scope: 'all' as const };
const mcpTool = (name: string) => {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no MCP tool ${name}`);
  return tool.handler;
};

// ── Pure detectors ─────────────────────────────────────────────────────────

describe('detectSuccessOnly', () => {
  test('flags a route seen often with only success statuses, saying observed reach', () => {
    const [gap] = gaps.detectSuccessOnly([
      { key: 'GET /api/orders', method: 'GET', pattern: '/api/orders', count: 40, statuses: [200, 200, 304] },
    ]);
    expect(gap!.detector).toBe('success-only');
    expect(gap!.class).toBe('blind-spot');
    expect(gap!.key).toBe('GET /api/orders');
    expect(gap!.evidence[0]).toContain('observed reach');
    expect(gap!.confidence).toBeGreaterThan(0);
  });

  test('does not flag a route that has seen an error status', () => {
    expect(
      gaps.detectSuccessOnly([
        { key: 'GET /api/orders', method: 'GET', pattern: '/api/orders', count: 40, statuses: [200, 500] },
      ]),
    ).toEqual([]);
  });

  test('does not flag a route seen too few times to claim a pattern', () => {
    expect(
      gaps.detectSuccessOnly([{ key: 'GET /api/x', method: 'GET', pattern: '/api/x', count: 2, statuses: [200] }]),
    ).toEqual([]);
  });
});

describe('detectSingleCoveringTest', () => {
  test('flags a node reached by exactly one test', () => {
    const [gap] = gaps.detectSingleCoveringTest([
      { nodeKind: 'route', nodeKey: 'POST /api/orders', tests: [{ testCaseId: 7, title: 'checkout › coupon' }] },
    ]);
    expect(gap!.detector).toBe('single-covering-test');
    expect(gap!.class).toBe('fragile');
    expect(gap!.testCaseId).toBe(7);
    expect(gap!.evidence[0]).toContain('checkout › coupon');
    expect(gap!.evidence[0]).toContain('observed reach');
  });

  test('ignores a node reached by two or more tests', () => {
    expect(
      gaps.detectSingleCoveringTest([
        {
          nodeKind: 'route',
          nodeKey: 'POST /api/orders',
          tests: [
            { testCaseId: 1, title: 'a' },
            { testCaseId: 2, title: 'b' },
          ],
        },
      ]),
    ).toEqual([]);
  });
});

describe('detectSurfaceDrift', () => {
  test('flags a node first seen in the latest run', () => {
    const [gap] = gaps.detectSurfaceDrift(
      [{ nodeKind: 'page', nodeKey: '/billing/plans', firstSeenRunId: 830, reachCount: 0 }],
      830,
    );
    expect(gap!.detector).toBe('surface-drift');
    expect(gap!.evidence[0]).toBe('Appeared in run #830; no test reaches it yet — observed reach.');
  });

  test('a new node a test already reaches is covered, not drift', () => {
    expect(
      gaps.detectSurfaceDrift(
        [{ nodeKind: 'page', nodeKey: '/users/invite', firstSeenRunId: 830, reachCount: 1 }],
        830,
      ),
    ).toEqual([]);
  });

  test('ignores an older node', () => {
    expect(
      gaps.detectSurfaceDrift([{ nodeKind: 'page', nodeKey: '/x', firstSeenRunId: 800, reachCount: 3 }], 830),
    ).toEqual([]);
  });

  test('a feature is derived from tags, never new surface', () => {
    expect(
      gaps.detectSurfaceDrift([{ nodeKind: 'feature', nodeKey: 'Checkout', firstSeenRunId: 830, reachCount: 0 }], 830),
    ).toEqual([]);
  });

  test('the run that built the graph first is the baseline, not drift', () => {
    const nodes = [
      { nodeKind: 'page', nodeKey: '/checkout', firstSeenRunId: 830, reachCount: 0 },
      { nodeKind: 'route', nodeKey: 'POST /api/orders', firstSeenRunId: 830, reachCount: 0 },
    ];
    expect(gaps.detectSurfaceDrift(nodes, 830, 830)).toEqual([]);
    expect(gaps.detectSurfaceDrift(nodes, 830, 812)).toHaveLength(2);
  });

  test('names a link by its accessible name, without its key prefix', () => {
    const [gap] = gaps.detectSurfaceDrift(
      [{ nodeKind: 'link', nodeKey: 'link:Single sign-on', firstSeenRunId: 830, reachCount: 0 }],
      830,
      812,
    );
    expect(gap!.title).toBe('New link Single sign-on — confirm it is tested');
    expect(gap!.key).toBe('link:link:Single sign-on');
    expect(gaps.subjectFromGapKey(gap!.key)).toEqual({ kind: 'link', key: 'link:Single sign-on' });
  });
});

describe('subjectFromGapKey', () => {
  test('resolves the M3 gap-key prefixes to their graph node', () => {
    expect(gaps.subjectFromGapKey('dependency:payments-svc')).toEqual({ kind: 'dependency', key: 'payments-svc' });
    // The not-handled finding's composite key resolves to the dependency subject.
    expect(gaps.subjectFromGapKey('dependency:payments-svc @ POST /api/orders')).toEqual({
      kind: 'dependency',
      key: 'payments-svc',
    });
    expect(gaps.subjectFromGapKey('feature:Checkout')).toEqual({ kind: 'feature', key: 'Checkout' });
    expect(gaps.subjectFromGapKey('ticket:JIRA-42')).toEqual({ kind: 'ticket', key: 'JIRA-42' });
    expect(gaps.subjectFromGapKey('handler:src/api/orders.post.ts')).toEqual({
      kind: 'handler',
      key: 'src/api/orders.post.ts',
    });
  });

  test('keeps the existing prefixes and raw-key fallbacks', () => {
    expect(gaps.subjectFromGapKey('route:GET /api/cart')).toEqual({ kind: 'route', key: 'GET /api/cart' });
    expect(gaps.subjectFromGapKey('page:/checkout')).toEqual({ kind: 'page', key: '/checkout' });
    expect(gaps.subjectFromGapKey('GET /api/cart')).toEqual({ kind: 'route', key: 'GET /api/cart' });
    expect(gaps.subjectFromGapKey('server/api/orders.post.ts')).toEqual({
      kind: 'file',
      key: 'server/api/orders.post.ts',
    });
  });
});

describe('detectChangedUnreached', () => {
  test('says no test of the run or of the window reached it, as observed reach', () => {
    const [gap] = gaps.detectChangedUnreached(
      [{ filePath: 'server/api/orders.post.ts', additions: 41, deletions: 3, reach: 'unreached' }],
      812,
      30,
    );
    expect(gap!.detector).toBe('changed-unreached');
    expect(gap!.evidence).toEqual(['+41 −3 · no test in run #812 or in the last 30 runs — observed reach.']);
    expect(gap!.confidence).toBeCloseTo(0.9);
    expect(gap!.files).toEqual(['server/api/orders.post.ts']);
  });

  test('ignores a reached file, one reached in the window and one nothing observes', () => {
    expect(
      gaps.detectChangedUnreached(
        [
          { filePath: 'a.ts', additions: 1, deletions: 0, reach: 'reached' },
          { filePath: 'b.ts', additions: 1, deletions: 0, reach: 'reached-earlier' },
          { filePath: 'c.md', additions: 1, deletions: 0, reach: 'not-observable' },
        ],
        1,
      ),
    ).toEqual([]);
  });
});

// ── Exposure ranking (pure) ────────────────────────────────────────────────

describe('exposure ranking', () => {
  test('every factor stays at or above the floor', () => {
    const factors = gaps.exposureFactorsFor(
      { detector: 'd', kind: 'gap', class: 'blind-spot', key: 'k', title: 't', evidence: [], confidence: 1 },
      {},
    );
    expect(factors.churn).toBe(gaps.FACTOR_FLOOR);
    expect(factors.age).toBe(gaps.FACTOR_FLOOR);
    expect(factors.escapeHistory).toBe(gaps.FACTOR_FLOOR);
    expect(factors.priority).toBe(gaps.FACTOR_FLOOR);
  });

  test('priority maps to its factor', () => {
    expect(gaps.priorityFactor('critical')).toBe(1);
    expect(gaps.priorityFactor('low')).toBe(0.2);
    expect(gaps.priorityFactor(null)).toBe(gaps.FACTOR_FLOOR);
  });

  test('a changed file with churn, age and escape outranks a bare route gap', () => {
    const files = new Map([['src/orders.ts', { churn: 12, ageDays: 400, escaped: true }]]);
    const changed = gaps.rankGap(
      {
        detector: 'changed-unreached',
        kind: 'gap',
        class: 'blind-spot',
        key: 'src/orders.ts',
        title: 't',
        evidence: [],
        confidence: 0.9,
        files: ['src/orders.ts'],
        priority: 'high',
      },
      { files },
    );
    const route = gaps.rankGap(
      {
        detector: 'success-only',
        kind: 'gap',
        class: 'blind-spot',
        key: 'GET /x',
        title: 't',
        evidence: [],
        confidence: 0.9,
      },
      {},
    );
    expect(changed.score).toBeGreaterThan(route.score);
    expect(changed.factors.escapeHistory).toBe(1);
  });
});

// ── DB-backed orchestration ────────────────────────────────────────────────

let db: ReturnType<typeof drizzle<typeof schema>>;
let clock = 0;

async function seedRun(id: number): Promise<void> {
  await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'passed', startTime: new Date(++clock) });
}

async function seedReach(testCaseId: number, toKind: string, toKey: string, runId: number): Promise<void> {
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    fromKind: 'test',
    fromKey: String(testCaseId),
    toKind,
    toKey,
    kind: 'reaches',
    confidence: 1,
    lastSeenAt: new Date(++clock),
  });
  await db
    .insert(schema.graphNodes)
    .values({
      projectId: 1,
      kind: toKind,
      key: toKey,
      firstSeenRunId: runId,
      lastSeenRunId: runId,
      lastSeenAt: new Date(++clock),
    })
    .onConflictDoNothing();
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'gap-project' });
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'checkout › coupon' });
  clock = 0;
});

describe('computeScenarioGaps', () => {
  test("code reach's file nodes and reaches edges raise no gap", async () => {
    await seedRun(1);
    await seedRun(2);
    for (const file of ['src/lib/cart.ts', 'src/components/Pay.vue']) {
      await db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'test',
        fromKey: '1',
        toKind: 'file',
        toKey: file,
        kind: 'reaches',
        origin: 'coverage',
        confidence: 1,
        lastSeenAt: new Date(++clock),
      });
      await db.insert(schema.graphNodes).values({
        projectId: 1,
        kind: 'file',
        key: file,
        origin: 'coverage',
        firstSeenRunId: 2,
        lastSeenRunId: 2,
        lastSeenAt: new Date(++clock),
      });
    }

    await gaps.computeScenarioGaps(db, 1);
    const rows = await gaps.listScenarioGaps(db, 1, { status: 'all' });
    expect(rows.filter((r) => r.key.includes('src/'))).toEqual([]);
  });

  test('detects a single-covering-test gap and persists it as open', async () => {
    await seedRun(1);
    await seedReach(1, 'page', '/checkout', 1);

    const result = await gaps.computeScenarioGaps(db, 1);
    expect(result.upserted).toBeGreaterThan(0);

    const rows = await gaps.listScenarioGaps(db, 1, {});
    const single = rows.find((r) => r.detector === 'single-covering-test');
    expect(single).toBeTruthy();
    expect(single!.status).toBe('open');
    expect(single!.factors).not.toBeNull();
  });

  test('recomputation preserves triage — a dismissed gap stays dismissed', async () => {
    await seedRun(1);
    await seedReach(1, 'page', '/checkout', 1);
    await gaps.computeScenarioGaps(db, 1);

    await db
      .update(schema.scenarioGaps)
      .set({ status: 'dismissed' })
      .where(eq(schema.scenarioGaps.detector, 'single-covering-test'));
    await gaps.computeScenarioGaps(db, 1);

    const [row] = await db
      .select()
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.detector, 'single-covering-test'));
    expect(row!.status).toBe('dismissed');
  });

  test('a branch recompute never writes the project-wide ledger', async () => {
    await seedRun(1);
    await seedRun(2); // the latest run

    // A canonical route first seen earlier — not drift.
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/cart',
      firstSeenRunId: 1,
      lastSeenRunId: 2,
      lastSeenAt: new Date(++clock),
    });
    // A route added on a pull-request branch in the latest run.
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/new',
      branch: 'pr-1',
      firstSeenRunId: 2,
      lastSeenRunId: 2,
      lastSeenAt: new Date(++clock),
    });

    // On the default branch only canonical rows are read — the PR route is absent.
    await gaps.computeScenarioGaps(db, 1);
    const drift = await gaps.listScenarioGaps(db, 1, { detector: 'surface-drift', status: 'all' });
    expect(drift.find((r) => r.key === 'route:GET /api/new')).toBeFalsy();

    // A canonical open gap that a PR's reach must not be able to close.
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'single-covering-test',
      class: 'fragile',
      key: 'route:GET /api/cart',
      title: 'single',
      status: 'open',
    });
    const before = await gaps.listScenarioGaps(db, 1, { status: 'all' });

    // The shared ledger has no branch dimension, so a branch recompute is a
    // ledger no-op: it creates no PR-only gap and closes no canonical gap.
    const result = await gaps.computeScenarioGaps(db, 1, { branch: 'pr-1' });
    expect(result).toEqual({ upserted: 0, closed: 0 });

    const after = await gaps.listScenarioGaps(db, 1, { status: 'all' });
    expect(after.map((r) => `${r.detector}:${r.key}:${r.status}`).sort()).toEqual(
      before.map((r) => `${r.detector}:${r.key}:${r.status}`).sort(),
    );
    expect(after.find((r) => r.key === 'route:GET /api/new')).toBeFalsy();
  });

  test('a newly documented (manifest/openapi) route does not also fire surface drift', async () => {
    await seedRun(1);
    // A declared route stamped with the latest run on ingest: it is a
    // declared-never-hit candidate, never surface drift.
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/documented',
      origin: 'manifest',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(++clock),
    });

    await gaps.computeScenarioGaps(db, 1);
    const drift = await gaps.listScenarioGaps(db, 1, { detector: 'surface-drift', status: 'all' });
    expect(drift.find((r) => r.key === 'route:GET /api/documented')).toBeFalsy();
    // It is still eligible for the declared-never-hit detector.
    const declared = await gaps.listScenarioGaps(db, 1, { detector: 'declared-never-hit', status: 'all' });
    expect(declared.find((r) => r.subject.key === 'GET /api/documented')).toBeTruthy();
  });

  test('a declared route or page is reached through the requests its pattern serves', async () => {
    await seedRun(1);
    const declare = (kind: string, key: string, patterns: string[], responses: number[] = []) =>
      db.insert(schema.graphNodes).values({
        projectId: 1,
        kind,
        key,
        origin: 'manifest',
        attrs: kind === 'route' ? { declared: true, responses, patterns } : { declared: true, patterns },
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        lastSeenAt: new Date(++clock),
      });
    await declare('route', 'GET /blog/:id', ['/blog/{slug}']);
    await declare('route', 'GET /orders/:id', ['/orders/{id:int}']);
    await declare('page', '/docs/:id', ['/docs/{**path}']);
    await seedReach(1, 'route', 'GET /blog/hello-world', 1);
    await seedReach(1, 'route', 'GET /orders/export', 1);
    await seedReach(1, 'page', '/docs/guide/install', 1);

    await gaps.computeScenarioGaps(db, 1);

    const declared = await gaps.listScenarioGaps(db, 1, { detector: 'declared-never-hit', status: 'all' });
    expect(declared.map((r) => r.key)).toEqual(['route:GET /orders/:id']);
    // The declared node lends nothing back: the observed route stays the one surface the test covers.
    const single = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test', status: 'all' });
    expect(single.map((r) => r.key).sort()).toEqual([
      'page:/docs/guide/install',
      'route:GET /blog/hello-world',
      'route:GET /orders/export',
    ]);
  });

  test('a route a test reached before the manifest declared it still wins over a wider declared pattern', async () => {
    await seedRun(1);
    await seedReach(1, 'route', 'GET /orders/new', 1);
    // The manifest declares the reached route after the fact: origin stays `observed`, the attrs say declared.
    await db
      .update(schema.graphNodes)
      .set({ attrs: { declared: true, responses: [], patterns: ['/orders/new'] } })
      .where(eq(schema.graphNodes.key, 'GET /orders/new'));
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /orders/:id',
      origin: 'manifest',
      attrs: { declared: true, responses: [], patterns: ['/orders/{slug}'] },
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(++clock),
    });

    await gaps.computeScenarioGaps(db, 1);

    const declared = await gaps.listScenarioGaps(db, 1, { detector: 'declared-never-hit', status: 'all' });
    expect(declared.map((r) => r.key)).toEqual(['route:GET /orders/:id']);
  });

  test('success-only names the codes the declared route serving an observed route documents', async () => {
    await seedRun(1);
    await db.insert(schema.testCases).values({ id: 2, projectId: 1, filePath: 'tests/x.spec.ts', title: 'x' });
    const [exec] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 2, status: 'passed', createdAt: new Date(++clock) })
      .returning({ id: schema.testRunsCases.id });
    await db.insert(schema.graphNodes).values([
      {
        projectId: 1,
        kind: 'route',
        key: 'GET /users/:id',
        origin: 'openapi',
        attrs: { declared: true, responses: [200, 404], patterns: ['/users/{username}'] },
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        lastSeenAt: new Date(++clock),
      },
      {
        projectId: 1,
        kind: 'route',
        key: 'GET /users/alice',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
        lastSeenAt: new Date(++clock),
      },
    ]);
    for (let i = 0; i < 6; i++) {
      await db
        .insert(schema.networkRequests)
        .values({ testRunsCaseId: exec!.id, testRunId: 1, method: 'GET', normalizedUrl: '/users/alice', status: 200 });
    }

    await gaps.computeScenarioGaps(db, 1);

    const list = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(list.map((r) => r.title)).toEqual(['GET /users/alice: documented 404 never tested']);

    // Another request the declared route serves returned the 404: it is no longer untested.
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /users/nobody',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(++clock),
    });
    await db
      .insert(schema.networkRequests)
      .values({ testRunsCaseId: exec!.id, testRunId: 1, method: 'GET', normalizedUrl: '/users/nobody', status: 404 });
    await gaps.computeScenarioGaps(db, 1);

    const after = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(after.map((r) => r.title)).toEqual(['GET /users/alice: no error path under test']);
  });

  test('closes a gap whose condition no longer holds', async () => {
    await seedRun(1);
    await seedReach(1, 'page', '/checkout', 1);
    await gaps.computeScenarioGaps(db, 1);

    // A second test now reaches the page, so it is no longer single-covered.
    await db.insert(schema.testCases).values({ id: 2, projectId: 1, filePath: 'tests/other.spec.ts', title: 'other' });
    await seedReach(2, 'page', '/checkout', 1);
    await gaps.computeScenarioGaps(db, 1);

    const open = await gaps.listScenarioGaps(db, 1, { status: 'open' });
    expect(open.find((r) => r.detector === 'single-covering-test')).toBeFalsy();
    const closed = await gaps.listScenarioGaps(db, 1, { status: 'closed' });
    expect(closed.find((r) => r.detector === 'single-covering-test')).toBeTruthy();
  });

  test('closes a changed-unreached gap once a test reaches the file’s route node', async () => {
    await seedRun(1);
    // An open changed-unreached gap for a route handler no test reached.
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'changed-unreached',
      class: 'blind-spot',
      key: 'server/api/orders/[id].get.ts',
      title: 'server/api/orders/[id].get.ts changed but not reached',
      status: 'open',
    });

    // A later run's test reaches the route the handler serves.
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 1, status: 'passed', createdAt: new Date() });
    await seedReach(1, 'route', 'GET /api/orders/:id', 1);
    await gaps.computeScenarioGaps(db, 1);

    const closed = await gaps.listScenarioGaps(db, 1, { status: 'closed' });
    const row = closed.find((r) => r.detector === 'changed-unreached');
    expect(row).toBeTruthy();
    expect(row!.key).toBe('server/api/orders/[id].get.ts');
  });

  test('the recompute closes a changed-unreached gap whose file a test executed, or that left the scope', async () => {
    await seedRun(1);
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 1, status: 'passed', createdAt: new Date() });
    const gap = (key: string) => ({
      projectId: 1,
      detector: 'changed-unreached',
      class: 'blind-spot',
      key,
      title: `${key} changed but not reached`,
      status: 'open',
    });
    await db
      .insert(schema.scenarioGaps)
      .values([gap('src/lib/cart.ts'), gap('src/lib/tax.ts'), gap('src/Client.g.cs')]);
    // The test executed cart.ts (code reach); nothing reaches tax.ts; Client.g.cs is generated, outside the scope.
    await db
      .insert(schema.codeReach)
      .values({ projectId: 1, testCaseId: 1, file: 'src/lib/cart.ts', runtime: 'browser', lastSeenAt: new Date() });

    await gaps.computeScenarioGaps(db, 1);

    const rows = await db
      .select({ key: schema.scenarioGaps.key, status: schema.scenarioGaps.status })
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.detector, 'changed-unreached'));
    expect(Object.fromEntries(rows.map((r) => [r.key, r.status]))).toEqual({
      'src/lib/cart.ts': 'closed',
      'src/lib/tax.ts': 'open',
      'src/Client.g.cs': 'closed',
    });
  });

  test('closes the open and snoozed changed-unreached gaps of files a diff no longer reads as uncovered', async () => {
    await seedRun(1);
    const gap = (key: string, status: string) => ({
      projectId: 1,
      detector: 'changed-unreached',
      class: 'blind-spot',
      key,
      title: `${key} changed but not reached`,
      status,
    });
    await db
      .insert(schema.scenarioGaps)
      .values([
        gap('src/a.ts', 'open'),
        gap('src/b.ts', 'snoozed'),
        gap('src/c.ts', 'dismissed'),
        gap('src/d.ts', 'open'),
      ]);

    expect(await gaps.closeChangedUnreachedGaps(db, 1, 1, ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toBe(2);

    const rows = await db
      .select({ key: schema.scenarioGaps.key, status: schema.scenarioGaps.status })
      .from(schema.scenarioGaps);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.status]))).toEqual({
      'src/a.ts': 'closed',
      'src/b.ts': 'closed',
      'src/c.ts': 'dismissed',
      'src/d.ts': 'open',
    });
  });

  test('success-only reads only routes the graph holds, not third-party beacons', async () => {
    await seedRun(1);
    await db.insert(schema.testCases).values({ id: 2, projectId: 1, filePath: 'tests/x.spec.ts', title: 'x' });
    const [exec] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 2, status: 'passed', createdAt: new Date(++clock) })
      .returning({ id: schema.testRunsCases.id });

    // A first-party route the graph holds as a node, seen only with success.
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/orders',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(++clock),
    });
    // The route and a third-party beacon, both seen often with success only. The
    // beacon has no route node, so it must not become a success-only gap.
    for (let i = 0; i < 6; i++) {
      await db.insert(schema.networkRequests).values([
        { testRunsCaseId: exec!.id, testRunId: 1, method: 'GET', normalizedUrl: '/api/orders', status: 200 },
        { testRunsCaseId: exec!.id, testRunId: 1, method: 'POST', normalizedUrl: '/collect', status: 204 },
      ]);
    }

    await gaps.computeScenarioGaps(db, 1);
    const list = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(list.map((r) => r.key)).toEqual(['GET /api/orders']);
  });

  test('a probe run’s injected 500 does not close a success-only gap', async () => {
    await seedRun(1); // a real run
    // A probe run stamped silent — its injected fault must never enter the window.
    const probeMetadata = { piwiProbe: true };
    await db.insert(schema.testRuns).values({
      id: 2,
      projectId: 1,
      status: 'failed',
      startTime: new Date(++clock),
      metadata: probeMetadata,
      origin: runOrigin(probeMetadata),
    });
    await db.insert(schema.testCases).values({ id: 2, projectId: 1, filePath: 'tests/x.spec.ts', title: 'x' });

    const [realExec] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 2, status: 'passed', createdAt: new Date(++clock) })
      .returning({ id: schema.testRunsCases.id });
    const [probeExec] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 2, testCaseId: 2, status: 'failed', createdAt: new Date(++clock) })
      .returning({ id: schema.testRunsCases.id });

    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/orders',
      firstSeenRunId: 1,
      lastSeenRunId: 2,
      lastSeenAt: new Date(++clock),
    });

    // The real run always saw success; the probe run injected a 500 on the route.
    for (let i = 0; i < 6; i++) {
      await db.insert(schema.networkRequests).values({
        testRunsCaseId: realExec!.id,
        testRunId: 1,
        method: 'GET',
        normalizedUrl: '/api/orders',
        status: 200,
      });
    }
    await db.insert(schema.networkRequests).values({
      testRunsCaseId: probeExec!.id,
      testRunId: 2,
      method: 'GET',
      normalizedUrl: '/api/orders',
      status: 500,
    });

    await gaps.computeScenarioGaps(db, 1);
    const list = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    // The injected 500 is excluded, so the route still reads as success-only.
    expect(list.map((r) => r.key)).toContain('GET /api/orders');
  });

  test('lab runs newer than every real run leave the history window its real runs', async () => {
    await seedRun(1);
    await db.insert(schema.testCases).values({ id: 2, projectId: 1, filePath: 'tests/x.spec.ts', title: 'x' });
    const [exec] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 2, status: 'passed', createdAt: new Date(++clock) })
      .returning({ id: schema.testRunsCases.id });
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/orders',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(++clock),
    });
    for (let i = 0; i < 6; i++) {
      await db.insert(schema.networkRequests).values({
        testRunsCaseId: exec!.id,
        testRunId: 1,
        method: 'GET',
        normalizedUrl: '/api/orders',
        status: 200,
      });
    }
    // Twice as many probe runs since then as the window holds.
    const probeMetadata = { piwiProbe: true };
    for (let id = 2; id <= 1 + 2 * gaps.HISTORY_WINDOW_RUNS; id++) {
      await db.insert(schema.testRuns).values({
        id,
        projectId: 1,
        status: 'failed',
        startTime: new Date(++clock),
        metadata: probeMetadata,
        origin: runOrigin(probeMetadata),
      });
    }

    await gaps.computeScenarioGaps(db, 1);
    const list = await gaps.listScenarioGaps(db, 1, { detector: 'success-only' });
    expect(list.map((r) => r.key)).toEqual(['GET /api/orders']);
  });

  test('two tests with opposite outcomes on one route do not flip the gap', async () => {
    await seedRun(1);
    await db.insert(schema.testCases).values({ id: 2, projectId: 1, filePath: 'tests/b.spec.ts', title: 'b' });
    // Two tests reach the route (exposure) and probe it with opposite outcomes.
    await seedReach(1, 'route', 'POST /api/orders', 1);
    await seedReach(2, 'route', 'POST /api/orders', 1);
    const checks = (testCaseId: number, outcome: string) =>
      db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'test',
        fromKey: String(testCaseId),
        toKind: 'route',
        toKey: 'POST /api/orders',
        kind: 'checks',
        evidence: { outcome, fault: 'status-500' },
        lastSeenAt: new Date(++clock),
      });
    await checks(1, 'noticed');
    await checks(2, 'not-noticed');

    await gaps.computeScenarioGaps(db, 1);
    // A route a trusted test noticed is checked, so it is never a not-noticed gap —
    // regardless of the order the edges came back from the database.
    const list = await gaps.listScenarioGaps(db, 1, { detector: 'not-noticed' });
    expect(list.find((r) => r.key === 'route:POST /api/orders')).toBeFalsy();
  });

  test('a flaky test noticing a probe does not check the route', async () => {
    await seedRun(1);
    await db
      .insert(schema.testCases)
      .values({ id: 2, projectId: 1, filePath: 'tests/b.spec.ts', title: 'b', flakyRootCause: 'timing' });
    await seedReach(1, 'route', 'POST /api/orders', 1);
    await seedReach(2, 'route', 'POST /api/orders', 1);
    for (const [testCaseId, outcome] of [
      [1, 'not-noticed'],
      [2, 'noticed'],
    ] as const) {
      await db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'test',
        fromKey: String(testCaseId),
        toKind: 'route',
        toKey: 'POST /api/orders',
        kind: 'checks',
        evidence: { outcome, fault: 'status-500' },
        lastSeenAt: new Date(++clock),
      });
    }

    await gaps.computeScenarioGaps(db, 1);
    const list = await gaps.listScenarioGaps(db, 1, { detector: 'not-noticed' });
    expect(list.map((r) => r.key)).toContain('route:POST /api/orders');
  });

  test('list_scenario_gaps keeps a success-only gap under a feature filter', async () => {
    await seedRun(1);
    await db
      .insert(schema.testCases)
      .values({ id: 2, projectId: 1, filePath: 'tests/x.spec.ts', title: 'x', feature: 'Orders' });
    const [exec] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: 1, testCaseId: 2, status: 'passed', createdAt: new Date(++clock) })
      .returning({ id: schema.testRunsCases.id });
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/orders',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(++clock),
    });
    for (let i = 0; i < 6; i++) {
      await db.insert(schema.networkRequests).values({
        testRunsCaseId: exec!.id,
        testRunId: 1,
        method: 'GET',
        normalizedUrl: '/api/orders',
        status: 200,
      });
    }
    // A test tagged with the feature reaches that route, so the feature groups it.
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '2',
      toKind: 'route',
      toKey: 'GET /api/orders',
      kind: 'reaches',
      lastSeenAt: new Date(++clock),
    });

    await gaps.computeScenarioGaps(db, 1);
    const result = (await mcpTool('list_scenario_gaps')(db, { projectId: 1, feature: 'Orders' }, mcpCtx)) as {
      items: Array<{ detector: string }>;
    };
    // The success-only gap keys on a raw route key; filtering must match on the
    // typed subject, so it survives the feature filter.
    expect(result.items.some((g) => g.detector === 'success-only')).toBe(true);
  });
});
