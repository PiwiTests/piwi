import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { ServerProbeSettings } from '../../shared/server-probes';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set, so
// clear it before the handler modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;
const { buildProbePlan, buildProbePlanForProject } = await import('../../shared/handlers/probes');
const { resolveProjectStates, setProjectDecisions } = await import('../../shared/handlers/capabilities');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const ENABLED: ServerProbeSettings = {
  enabled: true,
  faults: ['status'],
  routes: [],
  dependencyOnStateChanging: false,
};

async function freshDb(): Promise<Db> {
  const next = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(next);
  return next;
}

/** What a backend instrumentation sent on a request: its spans (Nitro), or only its logs (ASP.NET Core). */
type Backend = 'spans' | 'logs';

/** Record one run of the project with a request its backend instrumentation answered. */
async function recordBackendRequest(projectId: number, backend: Backend): Promise<void> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'passed', startTime: new Date(), duration: 1, totalTests: 1, passedTests: 1 })
    .returning({ id: schema.testRuns.id });
  const [runCase] = await db
    .insert(schema.testRunsCases)
    .values({ testRunId: run!.id, testCaseId: projectId, status: 'passed', duration: 1 })
    .returning({ id: schema.testRunsCases.id });
  await db.insert(schema.networkRequests).values({
    testRunsCaseId: runCase!.id,
    testRunId: run!.id,
    url: 'https://example.test/api/orders',
    method: 'GET',
    status: 200,
    ...(backend === 'spans' ? { serverTraces: [{ name: 'db.query', durationMs: 3 }] } : { serverLogs: [] }),
  });
}

/**
 * A project with server probes on whose five tests reach one route, enough that the client plan cannot claim the
 * whole budget, optionally with a request its backend answered.
 */
async function seedProject(projectId: number, backend: Backend | null): Promise<void> {
  await db.insert(schema.projects).values({ id: projectId, name: `p${projectId}`, serverProbes: ENABLED });
  const testCaseIds = [projectId, ...[0, 1, 2, 3].map((i) => projectId * 100 + i)];
  for (const id of testCaseIds) {
    await db.insert(schema.testCases).values({ id, projectId, filePath: `t${id}.spec.ts`, title: `t${id}` });
    await db.insert(schema.graphEdges).values({
      projectId,
      fromKind: 'test',
      fromKey: String(id),
      toKind: 'route',
      toKey: 'GET /api/orders',
      kind: 'reaches',
    });
  }
  if (backend) await recordBackendRequest(projectId, backend);
}

beforeEach(async () => {
  db = await freshDb();
});

describe('buildProbePlanForProject server-probes gating', () => {
  test('passes the project settings through, and server items get a real share of the budget', async () => {
    await seedProject(1, 'spans');

    // Enabled settings, no decline and no server probe yet resolve to `available`.
    expect((await resolveProjectStates(db, 1))['server-probes']).toBe('available');

    // The gated plan is exactly the plan built with the project's own settings.
    const gated = await buildProbePlanForProject(db, 1, { budget: 4 });
    const withSettings = await buildProbePlan(db, 1, { serverProbes: ENABLED, budget: 4 });
    expect(gated.items).toEqual(withSettings.items);

    // With server probes enabled and enough candidates, the plan carries level-two
    // items — they are not starved by a full client plan.
    expect(gated.items.some((i) => i.level === 'server')).toBe(true);
    expect(gated.items.length).toBeLessThanOrEqual(4);
  });

  test('drops the server settings when the project declined server-probes', async () => {
    await seedProject(1, 'spans');
    await setProjectDecisions(db, 1, { 'server-probes': 'declined' });

    expect((await resolveProjectStates(db, 1))['server-probes']).toBe('declined');

    // The gated plan matches the client-only plan, and carries no server items.
    const gated = await buildProbePlanForProject(db, 1, { budget: 4 });
    const clientOnly = await buildProbePlan(db, 1, { serverProbes: undefined, budget: 4 });
    expect(gated.items).toEqual(clientOnly.items);
    expect(gated.items.every((i) => i.level !== 'server')).toBe(true);
  });

  test('withholds server items until a backend instrumentation answered a request of the project', async () => {
    await seedProject(2, null);

    // The capability shows (available, never not applicable), but no server fault can apply yet.
    expect((await resolveProjectStates(db, 2))['server-probes']).toBe('available');
    expect(
      (await buildProbePlan(db, 2, { serverProbes: ENABLED, budget: 4 })).items.some((i) => i.level === 'server'),
    ).toBe(true);
    const gated = await buildProbePlanForProject(db, 2, { budget: 4 });
    expect(gated.items).toEqual((await buildProbePlan(db, 2, { serverProbes: undefined, budget: 4 })).items);
    expect(gated.items.every((i) => i.level !== 'server')).toBe(true);

    // A request carrying only backend logs, as the ASP.NET Core package answers outside a probe, is enough.
    await recordBackendRequest(2, 'logs');
    const answered = await buildProbePlanForProject(db, 2, { budget: 4 });
    expect(answered.items.some((i) => i.level === 'server')).toBe(true);
  });
});
