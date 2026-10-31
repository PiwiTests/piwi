import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const gaps = await import('../../shared/handlers/scenario-gaps');
const { loadDetectorPrecision } = await import('../../shared/handlers/detector-precision');

// ── F12: readable combined score ─────────────────────────────────────────────

describe('scoreGap — geometric mean (F12)', () => {
  const bare = {
    detector: 'd',
    kind: 'gap' as const,
    class: 'blind-spot' as const,
    key: 'k',
    title: 't',
    evidence: [],
  };

  test('an all-floor gap scores near the floor, not the fourth power of it', () => {
    const floor = gaps.FACTOR_FLOOR;
    const score = gaps.scoreGap(
      { ...bare, confidence: 1 },
      { churn: floor, age: floor, escapeHistory: floor, priority: floor },
    );
    // Geometric mean of four 0.1s is 0.1, readable — never 1e-4.
    expect(score).toBeCloseTo(0.1, 6);
    expect(score).toBeGreaterThan(0.001);
  });

  test('ranking among equal-confidence gaps is unchanged by the transform', () => {
    const strong = gaps.scoreGap({ ...bare, confidence: 0.9 }, { churn: 1, age: 1, escapeHistory: 1, priority: 0.7 });
    const weak = gaps.scoreGap(
      { ...bare, confidence: 0.9 },
      { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
    );
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(1);
  });
});

// ── F6: control-nobody-exercises needs control reach ─────────────────────────

describe('detectControlNobodyExercises — needs control reach (F6)', () => {
  test('emits nothing when the project has no control reach at all', () => {
    expect(
      gaps.detectControlNobodyExercises([
        { key: 'button:Export', pageCount: 12, reachCount: 0 },
        { key: 'button:Save', pageCount: 3, reachCount: 0 },
      ]),
    ).toEqual([]);
  });

  test('still flags an unreached control once some control reach exists', () => {
    const out = gaps.detectControlNobodyExercises([
      { key: 'button:Export', pageCount: 12, reachCount: 0 },
      { key: 'button:Save', pageCount: 3, reachCount: 2 },
    ]);
    expect(out.map((g) => g.key)).toEqual(['control:button:Export']);
  });
});

// ── F7: trusted reach ────────────────────────────────────────────────────────

describe('detectSingleCoveringTest — trusted reach only (F7)', () => {
  test('a trusted test plus an untrusted one is still single-covered', () => {
    const out = gaps.detectSingleCoveringTest([
      {
        nodeKind: 'route',
        nodeKey: 'POST /api/orders',
        tests: [
          { testCaseId: 1, title: 'trusted', trusted: true },
          { testCaseId: 2, title: 'flaky', trusted: false },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.testCaseId).toBe(1);
  });

  test('a node only untrusted tests reach is raised, naming each test and why', () => {
    const [gap, ...rest] = gaps.detectSingleCoveringTest([
      {
        nodeKind: 'page',
        nodeKey: '/settings/appearance',
        tests: [
          { testCaseId: 3, title: 'toggles dark mode', trusted: false, untrustedReason: 'flaky' },
          {
            testCaseId: 4,
            title: 'keeps the density',
            priority: 'high',
            trusted: false,
            untrustedReason: 'quarantined',
          },
        ],
      },
    ]);
    expect(rest).toEqual([]);
    expect(gap!.class).toBe('fragile');
    expect(gap!.title).toBe('No trusted test reaches page /settings/appearance');
    expect(gap!.evidence[0]).toBe(
      'Only keeps the density (quarantined) and toggles dark mode (flaky) reach this — observed reach. A trusted scenario would make it resilient.',
    );
    // The highest-priority test is the one the draft starts from.
    expect(gap!.testCaseId).toBe(4);
    expect(gap!.priority).toBe('high');
  });

  test('the evidence names three untrusted tests, counts the rest, and says which did not run', () => {
    const [gap] = gaps.detectSingleCoveringTest([
      {
        nodeKind: 'page',
        nodeKey: '/dashboard',
        tests: [
          { testCaseId: 5, title: 'e', trusted: false, untrustedReason: 'quarantined' },
          { testCaseId: 1, title: 'a', trusted: false, untrustedReason: 'did-not-run' },
          { testCaseId: 4, title: 'd', trusted: false, untrustedReason: 'flaky' },
          { testCaseId: 2, title: 'b', trusted: false, untrustedReason: 'skipped' },
        ],
      },
    ]);
    expect(gap!.evidence[0]).toBe(
      'Only a (did not run), b (skipped), d (flaky) and 1 more reach this — observed reach. A trusted scenario would make it resilient.',
    );
    expect(gap!.testCaseId).toBe(1);
  });

  test('two trusted tests are not single-covered', () => {
    expect(
      gaps.detectSingleCoveringTest([
        {
          nodeKind: 'route',
          nodeKey: 'POST /api/orders',
          tests: [
            { testCaseId: 1, title: 'a', trusted: true },
            { testCaseId: 2, title: 'b', trusted: true },
          ],
        },
      ]),
    ).toEqual([]);
  });
});

// ── F1: dedupe before upsert ─────────────────────────────────────────────────

describe('dedupeScoredGaps (F1)', () => {
  test('keeps the highest-scoring row per (detector, key)', () => {
    const mk = (key: string, score: number) => ({
      detector: 'not-handled',
      kind: 'finding' as const,
      class: 'unhandled' as const,
      key,
      title: 't',
      evidence: [],
      confidence: 1,
      factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
      score,
    });
    const out = gaps.dedupeScoredGaps([mk('route:GET /a', 0.2), mk('route:GET /a', 0.9), mk('route:GET /b', 0.3)]);
    expect(out).toHaveLength(2);
    expect(out.find((g) => g.key === 'route:GET /a')!.score).toBe(0.9);
  });
});

// ── DB-backed ────────────────────────────────────────────────────────────────

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p' });
});

const scoredGap = (over: Partial<gaps.ScoredGap> = {}): gaps.ScoredGap => ({
  detector: 'not-handled',
  kind: 'finding',
  class: 'unhandled',
  key: 'route:GET /api/cart',
  title: 'GET /api/cart: unhandled failure',
  evidence: ['x'],
  confidence: 1,
  factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
  score: 0.5,
  ...over,
});

describe('upsertScenarioGaps batch safety + reopen (F1, F2)', () => {
  test('a batch with a duplicate (detector, key) writes one row', async () => {
    await gaps.upsertScenarioGaps(db, 1, [scoredGap({ score: 0.2 }), scoredGap({ score: 0.9 })], {});
    const rows = await db.select().from(schema.scenarioGaps);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(0.9); // highest-scoring row survived the dedupe
  });

  test('a closed gap detected again reopens; a dismissed one keeps its verdict', async () => {
    await gaps.upsertScenarioGaps(db, 1, [scoredGap()], {});
    await db
      .update(schema.scenarioGaps)
      .set({ status: 'closed', closedAt: new Date(), closedByRunId: 7 })
      .where(eq(schema.scenarioGaps.key, 'route:GET /api/cart'));
    // A second, dismissed gap must keep its verdict across a redetect.
    await gaps.upsertScenarioGaps(db, 1, [scoredGap({ key: 'route:GET /api/other' })], {});
    await db
      .update(schema.scenarioGaps)
      .set({ status: 'dismissed', dismissReason: 'wrong' })
      .where(eq(schema.scenarioGaps.key, 'route:GET /api/other'));

    await gaps.upsertScenarioGaps(db, 1, [scoredGap(), scoredGap({ key: 'route:GET /api/other' })], {});

    const [reopened] = await db
      .select()
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.key, 'route:GET /api/cart'));
    expect(reopened!.status).toBe('open');
    expect(reopened!.closedAt).toBeNull();
    expect(reopened!.closedByRunId).toBeNull();
    const [dismissed] = await db
      .select()
      .from(schema.scenarioGaps)
      .where(eq(schema.scenarioGaps.key, 'route:GET /api/other'));
    expect(dismissed!.status).toBe('dismissed');
  });
});

describe('loadDetectorPrecision — durable, per-gap verdicts (F9)', () => {
  test('an accepted gap that later closes still counts for its detector', async () => {
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'success-only',
      class: 'blind-spot',
      key: 'GET /a',
      title: 't',
      status: 'closed', // closed after being accepted
      acceptedAt: new Date(),
    });
    const [row] = (await loadDetectorPrecision(db, 1)).filter((r) => r.detector === 'success-only');
    expect(row!.for).toBe(1);
  });

  test('a covered-by credits only the gap it was given on, not every detector on the subject', async () => {
    // Two detectors flag the same subject; only one is marked covered-by.
    await db.insert(schema.scenarioGaps).values([
      {
        projectId: 1,
        detector: 'success-only',
        class: 'blind-spot',
        key: 'GET /api/cart',
        title: 't',
        status: 'open',
        coveredAt: new Date(),
      },
      {
        projectId: 1,
        detector: 'single-covering-test',
        class: 'fragile',
        key: 'route:GET /api/cart',
        title: 't',
        status: 'open',
      },
    ]);
    const result = await loadDetectorPrecision(db, 1);
    expect(result.find((r) => r.detector === 'success-only')!.for).toBe(1);
    // The other detector on the same subject earns no verdict from that covered-by.
    expect(result.find((r) => r.detector === 'single-covering-test')).toBeUndefined();
  });
});

describe('triageGap records the actor (F4)', () => {
  test('the triaging user id is stored on the gap', async () => {
    await db.insert(schema.users).values({ id: 5, username: 'reporter5', password: '', role: 'member', name: 'A' });
    await gaps.upsertScenarioGaps(
      db,
      1,
      [scoredGap({ detector: 'success-only', kind: 'gap', class: 'blind-spot', key: 'GET /a' })],
      {},
    );
    const [gap] = await db.select({ id: schema.scenarioGaps.id }).from(schema.scenarioGaps);
    await gaps.triageGap(db, 1, gap!.id, { verb: 'dismiss', reason: 'wrong', triagedByUserId: 5 });
    const [row] = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.id, gap!.id));
    expect(row!.triagedBy).toBe(5);
  });
});

describe('computeScenarioGaps — trusted reach discounts flaky/quarantined (F7)', () => {
  test('a node reached by one trusted and one quarantined test is still single-covered', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'trusted' },
      { id: 2, projectId: 1, filePath: 'b.spec.ts', title: 'quarantined' },
    ]);
    await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId: 2 });
    for (const id of [1, 2]) {
      await db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'test',
        fromKey: String(id),
        toKind: 'route',
        toKey: 'GET /api/cart',
        kind: 'reaches',
        confidence: 1,
        lastSeenAt: new Date(),
      });
    }
    await db.insert(schema.graphNodes).values({
      projectId: 1,
      kind: 'route',
      key: 'GET /api/cart',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      lastSeenAt: new Date(),
    });

    await gaps.computeScenarioGaps(db, 1);
    const list = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' });
    // Only the trusted test counts, so the route reads as single-covered.
    const gap = list.find((r) => r.subject.key === 'GET /api/cart');
    expect(gap).toBeTruthy();
    expect(gap!.testCaseId).toBe(1);
  });
});

describe('computeScenarioGaps — retired detectors and the first graph run', () => {
  test('a retired detector’s open and accepted rows close with no run credited, a dismissed one keeps its verdict', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    const row = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
      projectId: 1,
      detector: 'api-only-route',
      class: 'blind-spot',
      key,
      title: `${key} is reached only by request fixtures`,
      status,
      ...extra,
    });
    await db
      .insert(schema.scenarioGaps)
      .values([
        row('route:POST /a', 'open'),
        row('route:POST /b', 'accepted', { acceptedAt: new Date() }),
        row('route:POST /c', 'dismissed', { dismissReason: 'wrong' }),
      ]);

    await gaps.computeScenarioGaps(db, 1);
    const rows = await db.select().from(schema.scenarioGaps).where(eq(schema.scenarioGaps.detector, 'api-only-route'));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('route:POST /a')).toMatchObject({ status: 'closed', closedByRunId: null });
    expect(byKey.get('route:POST /b')).toMatchObject({ status: 'closed', closedByRunId: null });
    expect(byKey.get('route:POST /c')).toMatchObject({ status: 'dismissed', dismissReason: 'wrong' });
    expect((await loadDetectorPrecision(db, 1)).map((p) => p.detector)).not.toContain('api-only-route');
  });

  test('a pruned node still marks the run that built the graph, so later new surface drifts', async () => {
    for (const id of [1, 5]) {
      await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'passed', startTime: new Date(id) });
    }
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/old', firstSeenRunId: 1, lastSeenRunId: 1, prunedAt: new Date() },
      { projectId: 1, kind: 'page', key: '/redesigned', firstSeenRunId: 5, lastSeenRunId: 5 },
    ]);

    await gaps.computeScenarioGaps(db, 1);
    const drift = await gaps.listScenarioGaps(db, 1, { detector: 'surface-drift' });
    expect(drift.map((g) => g.subject.key)).toEqual(['/redesigned']);
  });
});

describe('computeScenarioGaps — control reach from the locator index', () => {
  test('a control a test clicks is reached, and the controls no test targets are raised', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'org.spec.ts', title: 'renames the org' });
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'page', key: '/settings', firstSeenRunId: 1, lastSeenRunId: 1 },
      { projectId: 1, kind: 'control', key: 'button:Save changes', firstSeenRunId: 1, lastSeenRunId: 1 },
      { projectId: 1, kind: 'control', key: 'button:Delete organization', firstSeenRunId: 1, lastSeenRunId: 1 },
    ]);
    for (const key of ['button:Save changes', 'button:Delete organization']) {
      await db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'page',
        fromKey: '/settings',
        toKind: 'control',
        toKey: key,
        kind: 'contains',
        lastSeenAt: new Date(),
      });
    }
    await db.insert(schema.locatorUsages).values({
      projectId: 1,
      testCaseId: 1,
      locator: "getByRole('button', { name: 'Save changes' })",
      target: "getByRole('button', { name: 'Save changes' })",
      action: 'click',
      browserName: 'chromium',
      callSite: 'org.spec.ts:7:5',
      lastSeenAt: new Date(),
    });

    await gaps.computeScenarioGaps(db, 1);
    const [edge] = await db
      .select()
      .from(schema.graphEdges)
      .where(eq(schema.graphEdges.toKey, 'button:Save changes'))
      .then((rows) => rows.filter((r) => r.kind === 'reaches'));
    expect(edge).toMatchObject({ fromKey: '1', evidence: { via: 'locator', action: 'operated' } });
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'control-nobody-exercises' });
    expect(raised.map((g) => g.subject.key)).toEqual(['button:Delete organization']);
  });

  test('a locator edge the index stops backing is removed, and a covered-by edge stays as triage wrote it', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'org.spec.ts', title: 'renames the org' },
      { id: 2, projectId: 1, filePath: 'org.spec.ts', title: 'deletes the org' },
    ]);
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'control', key: 'button:Save changes', firstSeenRunId: 1, lastSeenRunId: 1 },
      { projectId: 1, kind: 'control', key: 'button:Delete organization', firstSeenRunId: 1, lastSeenRunId: 1 },
    ]);
    const use = (testCaseId: number, name: string) => ({
      projectId: 1,
      testCaseId,
      locator: `getByRole('button', { name: '${name}' })`,
      target: `getByRole('button', { name: '${name}' })`,
      action: 'click',
      browserName: 'chromium',
      callSite: 'org.spec.ts:7:5',
      lastSeenAt: new Date(),
    });
    await db.insert(schema.locatorUsages).values([use(1, 'Save changes'), use(2, 'Delete organization')]);
    await db.insert(schema.graphEdges).values({
      projectId: 1,
      fromKind: 'test',
      fromKey: '2',
      toKind: 'control',
      toKey: 'button:Delete organization',
      kind: 'reaches',
      confidence: 1,
      origin: 'manual',
      evidence: { manual: true },
      lastSeenAt: new Date(),
    });
    const reaches = async () =>
      (await db.select().from(schema.graphEdges))
        .filter((r) => r.kind === 'reaches')
        .map((r) => ({ test: r.fromKey, key: r.toKey, origin: r.origin, evidence: r.evidence }))
        .sort((a, b) => a.key.localeCompare(b.key));

    await gaps.computeScenarioGaps(db, 1);
    await db.delete(schema.locatorUsages).where(eq(schema.locatorUsages.testCaseId, 1));
    await gaps.computeScenarioGaps(db, 1);

    expect(await reaches()).toEqual([
      { test: '2', key: 'button:Delete organization', origin: 'manual', evidence: { manual: true } },
    ]);
  });

  test('a snapshot on the use’s line names its element, and a use older than reach keeps reaches nothing', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const tenDaysAgo = new Date(Date.now() - 10 * DAY);
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'org.spec.ts', title: 'saves the org' },
      { id: 2, projectId: 1, filePath: 'org.spec.ts', title: 'deletes the org' },
    ]);
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'control', key: 'button:Save changes', firstSeenRunId: 1, lastSeenRunId: 1 },
      { projectId: 1, kind: 'control', key: 'button:Delete organization', firstSeenRunId: 1, lastSeenRunId: 1 },
    ]);
    for (const key of ['button:Save changes', 'button:Delete organization']) {
      await db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'page',
        fromKey: '/settings',
        toKind: 'control',
        toKey: key,
        kind: 'contains',
        lastSeenAt: new Date(),
      });
    }
    await db.insert(schema.locatorUsages).values([
      {
        projectId: 1,
        testCaseId: 1,
        locator: "getByTestId('save')",
        target: "getByTestId('save')",
        action: 'click',
        browserName: 'chromium',
        callSite: 'tests/org.spec.ts:7:5',
        page: '/settings',
        lastSeenAt: tenDaysAgo,
      },
      {
        projectId: 1,
        testCaseId: 2,
        locator: "getByRole('button', { name: 'Delete organization' })",
        target: "getByRole('button', { name: 'Delete organization' })",
        action: 'click',
        browserName: 'chromium',
        callSite: 'tests/org.spec.ts:12:5',
        page: '/settings',
        lastSeenAt: new Date(Date.now() - 200 * DAY),
      },
    ]);
    // The snapshot's stack names an absolute path and another column of the same line.
    await db.insert(schema.locatorSnapshots).values({
      testCaseId: 1,
      location: '/repo/tests/org.spec.ts:7:18',
      usedMethod: 'getByTestId',
      usedArgs: JSON.stringify(['save']),
      usedArgsFp: 'fp',
      elementAttrs: '{}',
      alternatives: JSON.stringify([
        { locator: "getByTestId('save')" },
        { locator: "getByRole('button', { name: 'Save changes' })" },
      ]),
      lastSeenAt: tenDaysAgo,
    });

    await gaps.computeScenarioGaps(db, 1);
    const edges = (await db.select().from(schema.graphEdges)).filter((r) => r.kind === 'reaches');
    expect(edges.map((e) => ({ test: e.fromKey, key: e.toKey, confidence: e.confidence }))).toEqual([
      { test: '1', key: 'button:Save changes', confidence: 0.9 },
    ]);
    expect(new Date(edges[0]!.lastSeenAt).getTime()).toBe(tenDaysAgo.getTime());
    const raised = await gaps.listScenarioGaps(db, 1, { detector: 'control-nobody-exercises' });
    expect(raised.map((g) => g.subject.key)).toEqual(['button:Delete organization']);
  });

  test('a test operating an unnamed element keeps its page’s controls from reading as untested or single-covered', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'org.spec.ts', title: 'saves the org' },
      { id: 2, projectId: 1, filePath: 'org.spec.ts', title: 'deletes the org' },
    ]);
    const controls: Array<[string, string]> = [
      ['/settings', 'button:Save changes'],
      ['/settings', 'button:Delete organization'],
      ['/projects', 'button:Archive'],
    ];
    for (const [page, key] of controls) {
      await db.insert(schema.graphNodes).values({
        projectId: 1,
        kind: 'control',
        key,
        firstSeenRunId: 1,
        lastSeenRunId: 1,
      });
      await db.insert(schema.graphEdges).values({
        projectId: 1,
        fromKind: 'page',
        fromKey: page,
        toKind: 'control',
        toKey: key,
        kind: 'contains',
        lastSeenAt: new Date(),
      });
    }
    const use = (testCaseId: number, target: string) => ({
      projectId: 1,
      testCaseId,
      locator: target,
      target,
      action: 'click',
      browserName: 'chromium',
      callSite: `tests/org.spec.ts:${testCaseId}:5`,
      page: '/settings',
      lastSeenAt: new Date(),
    });
    await db
      .insert(schema.locatorUsages)
      .values([use(1, "getByRole('button', { name: 'Save changes' })"), use(2, "getByTestId('danger-zone')")]);

    await gaps.computeScenarioGaps(db, 1);
    const untested = await gaps.listScenarioGaps(db, 1, { detector: 'control-nobody-exercises' });
    expect(untested.map((g) => g.subject.key)).toEqual(['button:Archive']);
    const single = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' });
    expect(single.map((g) => g.subject.key)).not.toContain('button:Save changes');
  });
});

describe('computeScenarioGaps — exposure from recorded changes', () => {
  test('a route gap takes churn and escape history from the commits recorded on its handler file', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db
      .insert(schema.testCases)
      .values({ id: 1, projectId: 1, filePath: 'orders.spec.ts', title: 'places an order' });
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'POST /api/orders', firstSeenRunId: 1, lastSeenRunId: 1 },
      { projectId: 1, kind: 'handler', key: 'server/api/orders.post.ts', firstSeenRunId: 1, lastSeenRunId: 1 },
    ]);
    const edge = (fromKind: string, fromKey: string, kind: string, toKind: string, toKey: string) => ({
      projectId: 1,
      fromKind,
      fromKey,
      kind,
      toKind,
      toKey,
      lastSeenAt: new Date(),
    });
    await db
      .insert(schema.graphEdges)
      .values([
        edge('test', '1', 'reaches', 'route', 'POST /api/orders'),
        edge('route', 'POST /api/orders', 'handled-by', 'handler', 'server/api/orders.post.ts'),
        ...['aaaaaaa1111', 'bbbbbbb2222', 'ccccccc3333'].map((sha) =>
          edge('commit', sha, 'changes', 'file', 'apps/shop/server/api/orders.post.ts'),
        ),
      ]);
    await db.insert(schema.failureClusters).values({
      projectId: 1,
      fingerprint: 'fp',
      signature: 'TypeError',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      fixCommit: 'bbbbbbb',
    });

    await gaps.computeScenarioGaps(db, 1);
    const [gap] = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' });
    expect(gap!.factors).toMatchObject({ churn: 0.25, escapeHistory: 1, age: 0.1 });
  });

  test('diffs from one base count once, and a handler two recorded paths end with takes no churn', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'orders.spec.ts', title: 'places an order' },
      { id: 2, projectId: 1, filePath: 'health.spec.ts', title: 'reports health' },
    ]);
    await db.insert(schema.graphNodes).values([
      { projectId: 1, kind: 'route', key: 'POST /api/orders', firstSeenRunId: 1, lastSeenRunId: 1 },
      { projectId: 1, kind: 'route', key: 'GET /api/health', firstSeenRunId: 1, lastSeenRunId: 1 },
    ]);
    const edge = (
      fromKind: string,
      fromKey: string,
      kind: string,
      toKind: string,
      toKey: string,
      evidence?: object,
    ) => ({
      projectId: 1,
      fromKind,
      fromKey,
      kind,
      toKind,
      toKey,
      evidence: evidence ?? null,
      lastSeenAt: new Date(),
    });
    await db.insert(schema.graphEdges).values([
      edge('test', '1', 'reaches', 'route', 'POST /api/orders'),
      edge('test', '2', 'reaches', 'route', 'GET /api/health'),
      edge('route', 'POST /api/orders', 'handled-by', 'handler', 'server/api/orders.post.ts'),
      edge('route', 'GET /api/health', 'handled-by', 'handler', 'server/api/health.get.ts'),
      // Three runs of a red streak, each diffed again from the same green run, then one more diff.
      ...['aaaaaaa1', 'bbbbbbb2', 'ccccccc3'].map((sha) =>
        edge('commit', sha, 'changes', 'file', 'server/api/orders.post.ts', { base: 'green01' }),
      ),
      edge('commit', 'ddddddd4', 'changes', 'file', 'server/api/orders.post.ts', { base: 'ccccccc3' }),
      // Two apps of a monorepo hold a file of that name.
      ...['eeeeeee5', 'fffffff6'].flatMap((sha) => [
        edge('commit', sha, 'changes', 'file', 'apps/web/server/api/health.get.ts'),
        edge('commit', sha, 'changes', 'file', 'apps/admin/server/api/health.get.ts'),
      ]),
    ]);

    await gaps.computeScenarioGaps(db, 1);
    const single = await gaps.listScenarioGaps(db, 1, { detector: 'single-covering-test' });
    const factors = new Map(single.map((g) => [g.subject.key, g.factors]));
    expect(factors.get('POST /api/orders')).toMatchObject({ churn: 2 / 12 });
    expect(factors.get('GET /api/health')).toMatchObject({ churn: 0.1 });
  });
});

describe('draftScenario does not leak another project’s test (F3)', () => {
  test('a gap testCaseId from another project is not loaded as the nearest test', async () => {
    // Project 2 owns a secret-titled test; project 1's gap points at its id.
    await db.insert(schema.projects).values({ id: 2, name: 'other' });
    await db
      .insert(schema.testCases)
      .values({ id: 99, projectId: 2, title: 'SECRET project-B test', filePath: 'secret/b.spec.ts' });
    await db.insert(schema.scenarioGaps).values({
      projectId: 1,
      detector: 'success-only',
      class: 'blind-spot',
      key: 'GET /api/cart',
      title: 'gap',
      status: 'open',
      testCaseId: 99, // a cross-project id
    });
    const [gap] = await db.select({ id: schema.scenarioGaps.id }).from(schema.scenarioGaps);
    const draft = await gaps.draftScenario(db, 1, gap!.id);
    expect(draft).not.toBeNull();
    expect(draft!.text).not.toContain('SECRET');
    expect(draft!.text).not.toContain('secret/b.spec.ts');
    expect(draft!.nearestTest).toBeNull();
  });
});
