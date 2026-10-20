import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);
vi.mock('../../server/utils/ai-diagnosis', () => ({ autoDiagnoseRun: vi.fn(async () => {}) }));
vi.mock('../../server/utils/scm/pr-feedback', () => ({
  analyzeFinishedRunInBackground: vi.fn(() => ({ fixed: Promise.resolve([]), coverage: Promise.resolve(null) })),
  postRunPrFeedbackInBackground: vi.fn(async () => {}),
}));
vi.mock('../../server/utils/heal/policy', () => ({ maybeEnqueueHealActionInBackground: vi.fn() }));

interface RouteEvent {
  params: Record<string, string>;
  body: unknown;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params[name]);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);

type Handler = (event: RouteEvent) => Promise<any>;
const gate = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/gate.post')).default as unknown as Handler,
);
const markIncident = underRoutePermission(
  state,
  (await import('../../server/api/test-runs/[id]/incident.post')).default as unknown as Handler,
);
const { runFinalizeSideEffects } = await import('../../server/utils/run-finalize-side-effects');
const { getProjectFlakyTests } = await import('#shared/handlers/projects');
const { buildNotificationDedupeKey, passesSubscriptionFilters } = await import('#shared/notification-events');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const STAGING = 'https://staging.example.test';
const refused = (path: string) => `Error: page.goto: net::ERR_CONNECTION_REFUSED at ${STAGING}${path}`;
const T0 = new Date('2026-10-01T14:00:00Z');
let executionId = 1;

async function seedRun(runId: number, projectId: number, startTime: Date, total: number, failing: number) {
  await db.insert(schema.testRuns).values({
    id: runId,
    projectId,
    status: failing > 0 ? 'failed' : 'passed',
    startTime,
    duration: 4 * 60_000,
    totalTests: total,
    passedTests: total - failing,
    failedTests: failing,
    branch: 'main',
    metadata: { htmlReport: { projects: [{ name: 'chromium', use: { baseURL: `${STAGING}/` } }] } },
  });
  for (let i = 0; i < total; i++) {
    const caseId = projectId * 1000 + i;
    await db
      .insert(schema.testCases)
      .values({ id: caseId, projectId, filePath: 'checkout.spec.ts', title: `test ${i}` })
      .onConflictDoNothing();
    await db.insert(schema.testRunsCases).values({
      id: executionId++,
      testRunId: runId,
      testCaseId: caseId,
      status: i < failing ? 'failed' : 'passed',
      error: i < failing ? refused(`/page-${i}`) : null,
      duration: 900,
      createdAt: new Date(startTime.getTime() + i),
    });
  }
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  state.db = db;
  state.caller = { user: { id: 0, role: InstanceRole.ADMINISTRATOR, name: 'System' } as User, access: ADMIN_ACCESS };
  executionId = 1;
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout', defaultBranch: 'main' },
    { id: 2, name: 'storefront', defaultBranch: 'main' },
  ]);
});

describe('the staging host refuses connections during one run in two projects', () => {
  test('one incident marker per run, one event per channel, unchanged flaky scores, an inconclusive gate', async () => {
    const [channel] = await db
      .insert(schema.notificationChannels)
      .values({ name: 'Team', type: 'browser', config: {} })
      .returning();
    await db.insert(schema.subscriptions).values({
      channelId: channel!.id,
      events: ['environment.incident', 'run.failed', 'cluster.new', 'flakiness.spike'],
    });

    // Earlier green runs of the first project, so it has flaky scores to keep.
    await seedRun(1, 1, new Date(T0.getTime() - 2 * 3_600_000), 10, 0);
    await seedRun(2, 1, new Date(T0.getTime() - 3_600_000), 10, 1);
    const flakyBefore = await getProjectFlakyTests(db, 1, 50);

    await seedRun(3, 1, T0, 10, 10);
    await seedRun(4, 2, new Date(T0.getTime() + 5 * 60_000), 10, 9);
    // The outage opened a cluster in each project.
    for (const [runId, projectId] of [
      [3, 1],
      [4, 2],
    ] as const) {
      await db.insert(schema.failureClusters).values({
        projectId,
        fingerprint: `fp-${projectId}`,
        signature: 'page.goto: net::ERR_CONNECTION_REFUSED at <URL>',
        firstSeenRunId: runId,
        lastSeenRunId: runId,
      });
    }

    await runFinalizeSideEffects(db, 3, { projectId: 1, metadata: {} });
    await runFinalizeSideEffects(db, 4, { projectId: 2, metadata: {} });

    for (const runId of [3, 4]) {
      const marks = await db.select().from(schema.markers).where(eq(schema.markers.runId, runId));
      expect(marks.filter((m) => m.category === 'incident')).toHaveLength(1);
    }

    await vi.waitFor(async () => {
      const deliveries = await db.select().from(schema.notificationDeliveries);
      expect(deliveries.map((d) => d.event)).toEqual(['environment.incident']);
    });
    const [delivery] = await db.select().from(schema.notificationDeliveries);
    expect(delivery!.payload).toMatchObject({
      runId: 3,
      host: 'staging.example.test',
      incidentKey: 'staging.example.test:3',
    });

    expect(await getProjectFlakyTests(db, 1, 50)).toEqual(flakyBefore);

    for (const runId of [3, 4]) {
      const result = await gate({ params: { id: String(runId) }, body: { maxFailed: 0 } });
      expect(result.verdict).toBe('inconclusive');
      expect(result.passed).toBe(false);
      expect(result.facts.incident).toMatchObject({ host: 'staging.example.test' });
    }
  });
});

describe('the environment.incident event', () => {
  const payload = {
    runId: 3,
    projectId: 1,
    projectName: 'checkout',
    status: 'failed',
    totalTests: 10,
    failedTests: 10,
    rule: 'host-unreachable',
    reason: '10 of 10 tests failed',
    host: 'staging.example.test',
    otherProjects: 0,
    incidentKey: 'staging.example.test:3',
    branch: 'main',
  };

  test('two projects of one incident share a dedupe key on a channel', () => {
    const second = { ...payload, runId: 4, projectId: 2, projectName: 'storefront', otherProjects: 1 };
    expect(buildNotificationDedupeKey('environment.incident', second, 7)).toBe(
      buildNotificationDedupeKey('environment.incident', payload, 7),
    );
    expect(buildNotificationDedupeKey('environment.incident', payload, 8)).not.toBe(
      buildNotificationDedupeKey('environment.incident', payload, 7),
    );
  });

  test('goes to the project’s subscribers, not to a subscription scoped to test owners', () => {
    expect(passesSubscriptionFilters(null, 'environment.incident', payload)).toBe(true);
    expect(passesSubscriptionFilters({ branches: ['main'] }, 'environment.incident', payload)).toBe(true);
    expect(passesSubscriptionFilters({ branches: ['release/*'] }, 'environment.incident', payload)).toBe(false);
    expect(passesSubscriptionFilters({ owners: ['@team-checkout'] }, 'environment.incident', payload)).toBe(false);
  });
});

describe('a person marks and clears a run', () => {
  test('through the route, as an Uploader of the project, and the gate follows', async () => {
    await seedRun(1, 1, T0, 10, 2);
    state.caller = {
      user: { id: 5, role: InstanceRole.MEMBER, name: 'Ada' } as User,
      access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.UPLOADER }]),
    };
    const marked = await markIncident({
      params: { id: '1' },
      body: { incident: true, reason: 'The SSO sandbox was down' },
    });
    expect(marked.incident).toMatchObject({ rule: 'person', by: 'Ada', reason: 'The SSO sandbox was down' });
    expect((await gate({ params: { id: '1' }, body: { maxFailed: 0 } })).verdict).toBe('inconclusive');

    const cleared = await markIncident({ params: { id: '1' }, body: { incident: false } });
    expect(cleared).toMatchObject({ incident: null, review: { decision: 'cleared', by: 'Ada' } });
    expect((await gate({ params: { id: '1' }, body: { maxFailed: 0 } })).verdict).toBe('failed');
    // An Uploader's evaluations are stored.
    expect(await db.select().from(schema.gateEvaluations)).toHaveLength(2);
  });

  test('a Viewer of the project may not mark a run, and evaluates the gate without storing it', async () => {
    await seedRun(1, 1, T0, 10, 2);
    state.caller = {
      user: { id: 6, role: InstanceRole.MEMBER, name: 'Sam' } as User,
      access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
    };
    await expect(markIncident({ params: { id: '1' }, body: { incident: true } })).rejects.toMatchObject({
      statusCode: 403,
    });
    // A Viewer gets the verdict, and the evaluation is not stored.
    expect((await gate({ params: { id: '1' }, body: { maxFailed: 0 } })).verdict).toBe('failed');
    expect(await db.select().from(schema.gateEvaluations)).toHaveLength(0);
  });

  test('a bad body is refused', async () => {
    await seedRun(1, 1, T0, 10, 2);
    await expect(markIncident({ params: { id: '1' }, body: { incident: 'yes' } })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(markIncident({ params: { id: '99' }, body: { incident: true } })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
