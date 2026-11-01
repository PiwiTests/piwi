import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { ServerProbeSettings } from '../../shared/server-probes';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { buildProbePlan, recordProbeResults, PROBE_INCONCLUSIVE_COOLDOWN_MS } =
  await import('../../shared/handlers/probes');

const ENABLED: ServerProbeSettings = {
  enabled: true,
  faults: ['status'],
  routes: [],
  dependencyOnStateChanging: false,
};

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'p' });
});

async function seedReach(testCaseId: number, routeKey: string): Promise<void> {
  await db
    .insert(schema.testCases)
    .values({ id: testCaseId, projectId: 1, filePath: `t${testCaseId}.spec.ts`, title: `t${testCaseId}` })
    .onConflictDoNothing();
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    fromKind: 'test',
    fromKey: String(testCaseId),
    toKind: 'route',
    toKey: routeKey,
    kind: 'reaches',
    confidence: 1,
    lastSeenAt: new Date(),
  });
}

describe('buildProbePlan — server budget share (F5)', () => {
  test('server items get their own share instead of only the client plan’s leftovers', async () => {
    for (let i = 1; i <= 4; i++) await seedReach(i, `GET /api/r${i}`);
    const plan = await buildProbePlan(db, 1, { serverProbes: ENABLED, budget: 4 });
    const server = plan.items.filter((i) => i.level === 'server');
    const client = plan.items.filter((i) => i.level !== 'server');
    expect(client.length).toBeGreaterThan(0);
    expect(server.length).toBeGreaterThan(0); // the reserved share is actually used
    expect(plan.items.length).toBeLessThanOrEqual(4);
  });

  test('with server probes off, the whole budget goes to client items', async () => {
    for (let i = 1; i <= 4; i++) await seedReach(i, `GET /api/r${i}`);
    const plan = await buildProbePlan(db, 1, { budget: 4 });
    expect(plan.items.every((i) => i.level !== 'server')).toBe(true);
    expect(plan.items).toHaveLength(4);
  });
});

describe('buildProbePlan — exclude failing and quarantined tests (F11)', () => {
  test('a failing or quarantined test is not planned', async () => {
    await seedReach(1, 'GET /api/a'); // healthy
    await seedReach(2, 'GET /api/b'); // will fail
    await seedReach(3, 'GET /api/c'); // will be quarantined

    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date() })
      .returning({ id: schema.testRuns.id });
    await db.insert(schema.testRunsCases).values([
      { testRunId: run!.id, testCaseId: 1, status: 'passed', createdAt: new Date() },
      { testRunId: run!.id, testCaseId: 2, status: 'failed', createdAt: new Date() },
    ]);
    await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId: 3 });

    const plan = await buildProbePlan(db, 1, { budget: 50 });
    const ids = plan.items.map((i) => i.testCaseId);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
  });
});

describe('buildProbePlan — inconclusive cooldown (F11)', () => {
  async function seedInconclusiveProbe(ageMs: number): Promise<void> {
    await seedReach(1, 'GET /api/a');
    await db.insert(schema.probes).values({
      projectId: 1,
      testCaseId: 1,
      routeKey: 'GET /api/a',
      fault: 'status-500',
      outcome: 'inconclusive',
      level: 'client',
      probedAt: new Date(Date.now() - ageMs),
    });
  }

  test('re-probes an inconclusive pair after the cooldown', async () => {
    await seedInconclusiveProbe(PROBE_INCONCLUSIVE_COOLDOWN_MS + 60_000);
    const plan = await buildProbePlan(db, 1, { budget: 50 });
    expect(plan.items.map((i) => i.testCaseId)).toContain(1);
  });

  test('still blocks a recently-inconclusive pair', async () => {
    await seedInconclusiveProbe(60_000);
    const plan = await buildProbePlan(db, 1, { budget: 50 });
    expect(plan.items.map((i) => i.testCaseId)).not.toContain(1);
  });

  test('a pair probed only with a delay, which decides nothing, is planned again after the cooldown', async () => {
    await seedReach(1, 'GET /api/a');
    await db.insert(schema.probes).values({
      projectId: 1,
      testCaseId: 1,
      routeKey: 'GET /api/a',
      fault: 'slow',
      outcome: 'not-noticed',
      level: 'client',
      probedAt: new Date(Date.now() - PROBE_INCONCLUSIVE_COOLDOWN_MS - 60_000),
    });
    const plan = await buildProbePlan(db, 1, { budget: 50 });
    expect(plan.items.map((i) => i.testCaseId)).toContain(1);
  });

  test('a decided pair stays probed, whatever a later inconclusive probe said', async () => {
    await seedInconclusiveProbe(PROBE_INCONCLUSIVE_COOLDOWN_MS + 60_000);
    await db.insert(schema.probes).values({
      projectId: 1,
      testCaseId: 1,
      routeKey: 'GET /api/a',
      fault: 'empty-body',
      outcome: 'noticed',
      level: 'client',
      probedAt: new Date(Date.now() - 2 * PROBE_INCONCLUSIVE_COOLDOWN_MS),
    });
    const plan = await buildProbePlan(db, 1, { budget: 50 });
    expect(plan.items.map((i) => i.testCaseId)).not.toContain(1);
  });
});

describe('buildProbePlan — re-probe when the test changed', () => {
  const PROBED_AT = Date.UTC(2026, 8, 10);
  const DAY = 24 * 60 * 60 * 1000;
  let runSeq = 100;

  /** A passing execution whose steps ran from the given lines of the spec. */
  async function seedPass(at: number, lines: number[]): Promise<void> {
    const runId = ++runSeq;
    await db.insert(schema.testRuns).values({ id: runId, projectId: 1, status: 'passed', startTime: new Date(at) });
    await db.insert(schema.testRunsCases).values({
      testRunId: runId,
      testCaseId: 1,
      status: 'passed',
      createdAt: new Date(at),
      steps: [
        { title: 'Before Hooks', category: 'hook' },
        ...lines.map((line) => ({ title: `step at ${line}`, category: 'pw:api', location: `t1.spec.ts:${line}:5` })),
      ],
    });
  }

  async function seedNotNoticed(): Promise<void> {
    await seedReach(1, 'GET /api/a');
    await db.insert(schema.probes).values({
      projectId: 1,
      testCaseId: 1,
      routeKey: 'GET /api/a',
      fault: 'status-500',
      outcome: 'not-noticed',
      level: 'client',
      probedAt: new Date(PROBED_AT),
    });
  }

  test('an edit to the test after the probe makes the pair eligible again', async () => {
    await seedNotNoticed();
    await seedPass(PROBED_AT - DAY, [10, 11]);
    // The assertion that notices the fault was added after the probe.
    await seedPass(PROBED_AT + DAY, [10, 11, 12]);
    await seedPass(PROBED_AT + 2 * DAY, [10, 11, 12]);

    const plan = await buildProbePlan(db, 1, { budget: 50 });
    expect(plan.items.map((i) => i.testCaseId)).toContain(1);
  });

  test('a tag or owner change, or an edit before the probe, does not', async () => {
    await seedNotNoticed();
    await seedPass(PROBED_AT - 2 * DAY, [10, 11]);
    await seedPass(PROBED_AT - DAY, [10, 11, 12]);
    await seedPass(PROBED_AT + DAY, [10, 11, 12]);
    await db
      .update(schema.testCases)
      .set({ owner: 'team-cart', updatedAt: new Date(PROBED_AT + 2 * DAY) })
      .where(eq(schema.testCases.id, 1));

    const plan = await buildProbePlan(db, 1, { budget: 50 });
    expect(plan.items.map((i) => i.testCaseId)).not.toContain(1);
  });
});

describe('recordProbeResults — project scope + fault allow-list (F3, F5)', () => {
  async function seedRouteNode(): Promise<void> {
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'GET /api/a', origin: 'observed', lastSeenAt: new Date() });
  }

  test('drops a cross-project testCaseId', async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'other' });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'mine' },
      { id: 2, projectId: 2, filePath: 'b.spec.ts', title: 'theirs' },
    ]);
    await seedRouteNode();
    const { recorded } = await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'status-500', outcome: 'not-noticed', level: 'client' },
      { testCaseId: 2, routeKey: 'GET /api/a', fault: 'status-500', outcome: 'not-noticed', level: 'client' },
    ]);
    expect(recorded).toBe(1);
    const rows = await db.select().from(schema.probes);
    expect(rows.map((r) => r.testCaseId)).toEqual([1]);
  });

  test('drops a server fault the project did not allow-list', async () => {
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'mine' });
    await seedRouteNode();
    // The project's serverProbes are unset (disabled), so a server-level result is refused.
    const { recorded } = await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'status', outcome: 'not-noticed', level: 'server' },
    ]);
    expect(recorded).toBe(0);
  });
});

describe('recordProbeResults — which results decide a check', () => {
  async function seedRouteNode(): Promise<void> {
    await db
      .insert(schema.graphNodes)
      .values({ projectId: 1, kind: 'route', key: 'GET /api/a', origin: 'observed', lastSeenAt: new Date() });
  }
  const verdicts = async () =>
    (
      await db
        .select({ toKind: schema.graphEdges.toKind, evidence: schema.graphEdges.evidence })
        .from(schema.graphEdges)
    ).map((e) => ({ toKind: e.toKind, ...((e.evidence as { outcome?: string; fault?: string } | null) ?? {}) }));

  test('an inconclusive re-probe keeps the verdict, and a delay never makes one', async () => {
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'mine' });
    await seedRouteNode();
    const verdict = async () =>
      (await db.select({ evidence: schema.graphEdges.evidence }).from(schema.graphEdges)).map(
        (e) => (e.evidence as { outcome?: string; fault?: string } | null) ?? null,
      );
    await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'slow', outcome: 'not-noticed', level: 'client' },
    ]);
    expect(await verdict()).toEqual([]);
    await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'status-500', outcome: 'not-noticed', level: 'client' },
    ]);
    await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'empty-body', outcome: 'inconclusive', level: 'client' },
    ]);
    expect(await verdict()).toEqual([{ fault: 'status-500', outcome: 'not-noticed', level: 'client' }]);
    // Every result stays in the ledger.
    expect((await db.select().from(schema.probes)).map((r) => r.fault).sort()).toEqual([
      'empty-body',
      'slow',
      'status-500',
    ]);
  });

  test('results of one pair from several Playwright projects keep the one that says most', async () => {
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'mine' });
    await seedRouteNode();
    await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'status-500', outcome: 'noticed', level: 'client' },
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'status-500', outcome: 'inconclusive', level: 'client' },
    ]);
    expect((await db.select().from(schema.probes)).map((r) => r.outcome)).toEqual(['noticed']);
    await recordProbeResults(db, 1, null, [
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'empty-body', outcome: 'not-noticed', level: 'client' },
      { testCaseId: 1, routeKey: 'GET /api/a', fault: 'empty-body', outcome: 'noticed', level: 'client' },
    ]);
    expect(await verdicts()).toEqual([
      { toKind: 'route', fault: 'empty-body', outcome: 'not-noticed', level: 'client' },
    ]);
  });

  test('neither an undecided dependency probe nor an undecided server probe writes an edge or a finding', async () => {
    await db
      .update(schema.projects)
      .set({
        serverProbes: { enabled: true, faults: ['dependency', 'throw'], routes: [], dependencyOnStateChanging: false },
      })
      .where(eq(schema.projects.id, 1));
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'mine' });
    await seedRouteNode();
    await recordProbeResults(db, 1, null, [
      {
        testCaseId: 1,
        routeKey: 'GET /api/a',
        fault: 'dependency',
        dependency: 'db:postgres',
        outcome: 'inconclusive',
        level: 'server',
        handled: 'unhandled',
      },
      {
        testCaseId: 1,
        routeKey: 'GET /api/a',
        fault: 'throw',
        outcome: 'inconclusive',
        level: 'server',
        handled: 'unhandled',
      },
    ]);
    expect(await verdicts()).toEqual([]);
    expect(await db.select().from(schema.scenarioGaps)).toEqual([]);

    await recordProbeResults(db, 1, null, [
      {
        testCaseId: 1,
        routeKey: 'GET /api/a',
        fault: 'throw',
        outcome: 'noticed',
        level: 'server',
        handled: 'degraded',
      },
    ]);
    expect((await db.select().from(schema.scenarioGaps)).map((g) => g.detector)).toEqual(['not-handled']);
  });
});
