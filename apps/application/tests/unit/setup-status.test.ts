import { describe, test, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before the handler
// modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;
const { getSetupStatus, getCapabilityEvidence } = await import('../../shared/handlers/setup-status');
const { SETUP_CAPABILITIES } = await import('../../app/utils/setup-capabilities');
const { getAppSetting, setAppSetting } = await import('../../server/utils/app-settings');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

async function freshDb(): Promise<Db> {
  const next = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(next, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  return next;
}

/** Capability ids that report `active: true`, as a set. */
async function activeIds(database: Db): Promise<Set<string>> {
  const { capabilities } = await getSetupStatus(database);
  return new Set(capabilities.filter((c) => c.active).map((c) => c.id));
}

beforeEach(async () => {
  db = await freshDb();
  delete process.env.PIWI_AI_API_KEY;
  delete process.env.PIWI_AI_MODEL;
});

describe('getSetupStatus', () => {
  test('reports nothing active on a fresh instance', async () => {
    const { capabilities } = await getSetupStatus(db);
    expect(capabilities.length).toBeGreaterThan(0);
    expect(capabilities.every((c) => c.active === false)).toBe(true);
  });

  test('a submitted run activates only the reporter capability', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.testRuns).values({
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
    });

    expect(await activeIds(db)).toEqual(new Set(['reporter']));
  });

  test('captured network requests activate the fixtures capability', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date(), duration: 1, totalTests: 1, passedTests: 1 })
      .returning({ id: schema.testRuns.id });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'a' });
    const [runCase] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: run!.id, testCaseId: 1, status: 'passed', duration: 1 })
      .returning({ id: schema.testRunsCases.id });
    await db.insert(schema.networkRequests).values({
      testRunsCaseId: runCase!.id,
      testRunId: run!.id,
      url: 'https://example.test/api',
      method: 'GET',
      status: 200,
    });

    const active = await activeIds(db);
    expect(active.has('fixtures')).toBe(true);
    expect(active.has('locator-healing')).toBe(false);
    expect(active.has('backend-logs')).toBe(false);
  });

  test('a network request carrying server traces activates the backend-logs capability', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date(), duration: 1, totalTests: 1, passedTests: 1 })
      .returning({ id: schema.testRuns.id });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'a' });
    const [runCase] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: run!.id, testCaseId: 1, status: 'passed', duration: 1 })
      .returning({ id: schema.testRunsCases.id });
    await db.insert(schema.networkRequests).values({
      testRunsCaseId: runCase!.id,
      testRunId: run!.id,
      url: 'https://example.test/api',
      method: 'GET',
      status: 200,
      serverTraces: [{ name: 'db.query', durationMs: 12 }],
    });

    expect((await activeIds(db)).has('backend-logs')).toBe(true);
  });

  test('a pass on a retry activates the flake-lab capability; a first-attempt pass does not', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date(), duration: 1, totalTests: 1, passedTests: 1 })
      .returning({ id: schema.testRuns.id });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'a' });
    await db.insert(schema.testRunsCases).values({ testRunId: run!.id, testCaseId: 1, status: 'passed', retries: 0 });
    expect((await activeIds(db)).has('flake-lab')).toBe(false);

    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: run!.id, testCaseId: 1, status: 'failed', retries: 0, browserName: 'webkit' });
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: run!.id, testCaseId: 1, status: 'passed', retries: 1, browserName: 'webkit' });
    expect((await activeIds(db)).has('flake-lab')).toBe(true);
  });

  test('a graph node for the project activates the test-map capability', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    expect((await activeIds(db)).has('test-map')).toBe(false);

    await db.insert(schema.graphNodes).values({ projectId: 1, kind: 'route', key: 'GET /api/orders' });
    expect((await activeIds(db)).has('test-map')).toBe(true);
  });

  test('a stored coverage fragment activates the coverage capability, for its project only', async () => {
    await db.insert(schema.projects).values([
      { id: 1, name: 'checkout' },
      { id: 2, name: 'admin' },
    ]);
    expect((await activeIds(db)).has('coverage')).toBe(false);

    const now = new Date();
    await db.insert(schema.coverageFragments).values({
      projectId: 1,
      hash: 'a'.repeat(64),
      runtime: 'server',
      path: 'api/Users/UsersEndpoints.cs',
      createdAt: now,
      lastSeenAt: now,
    });
    expect((await activeIds(db)).has('coverage')).toBe(true);
    expect((await getCapabilityEvidence(db, 1)).coverage).toBe(true);
    expect((await getCapabilityEvidence(db, 2)).coverage).toBe(false);
  });

  test('a server-level probe row activates the server-probes capability; a client one does not', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.probes).values({ projectId: 1, fault: 'status-500', outcome: 'noticed', level: 'client' });
    expect((await activeIds(db)).has('server-probes')).toBe(false);

    await db.insert(schema.probes).values({ projectId: 1, fault: 'throw', outcome: 'noticed', level: 'server' });
    expect((await activeIds(db)).has('server-probes')).toBe(true);
  });

  test('a report schedule or a report snapshot activates the quality-reports capability', async () => {
    expect((await activeIds(db)).has('quality-reports')).toBe(false);
    await db.insert(schema.reportSnapshots).values({
      dashboardRef: 'executive',
      dashboardName: 'Executive',
      periodFrom: new Date('2026-09-14T00:00:00Z'),
      periodTo: new Date('2026-09-21T00:00:00Z'),
      bundle: {},
    });
    expect((await activeIds(db)).has('quality-reports')).toBe(true);
    await db.delete(schema.reportSnapshots);
    await db.insert(schema.reportSchedules).values({ name: 'Weekly', cadence: 'weekly', anchor: 1, at: '08:00' });
    expect((await activeIds(db)).has('quality-reports')).toBe(true);
  });

  test('detection is evidence-based, not config-based: a defined tag activates tags', async () => {
    await db.insert(schema.tags).values({ text: 'smoke' });

    expect(await activeIds(db)).toEqual(new Set(['tags']));
  });

  test('AI counts as active when pinned by environment, with no stored setting', async () => {
    expect((await activeIds(db)).has('ai')).toBe(false);

    process.env.PIWI_AI_MODEL = 'claude-sonnet-4-5';
    expect((await activeIds(db)).has('ai')).toBe(true);
  });

  test('AI counts as active from a stored setting, with no env var', async () => {
    await db.insert(schema.appSettings).values({ key: 'ai', value: { provider: 'anthropic' }, updatedAt: new Date() });

    expect((await activeIds(db)).has('ai')).toBe(true);
  });
});

describe('setup capability copy', () => {
  test('every detected capability has UI copy, and vice versa', async () => {
    const { capabilities } = await getSetupStatus(db);
    const detected = capabilities.map((c) => c.id).sort();
    const documented = SETUP_CAPABILITIES.map((c) => c.id).sort();

    expect(documented).toEqual(detected);
  });

  test('a capability that cannot be configured in-app still explains how to enable it', () => {
    for (const capability of SETUP_CAPABILITIES) {
      expect(capability.how.length).toBeGreaterThan(0);
      expect(capability.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('first-run version and the New marker', () => {
  test('records the running version on first read and marks nothing new', async () => {
    const first = await getSetupStatus(db, '0.90.0');
    expect(first.capabilities.every((c) => c.isNew === false)).toBe(true);

    // The recorded version sticks: a later, higher version does not re-anchor it.
    const recorded = await getAppSetting<string>(db, 'first-run-version');
    expect(recorded).toBe('0.90.0');
    const again = await getSetupStatus(db, '0.99.0');
    expect(again.capabilities.every((c) => c.isNew === false)).toBe(true);
  });

  test('marks capabilities whose release is newer than the first-run version', async () => {
    await setAppSetting(db, 'first-run-version', '0.20.0');
    const { capabilities } = await getSetupStatus(db, '0.36.0');
    const newIds = new Set(capabilities.filter((c) => c.isNew).map((c) => c.id));
    // auto-heal (0.26), integrations (0.29), the Test Map (0.36), quality
    // reports (0.39), bug reports and flake suspects (0.41) and resources
    // (0.45), the agent capabilities (0.46), coverage (0.54) and the assistant
    // (0.59) landed after 0.20; pr-feedback (0.19) did not.
    expect(newIds).toEqual(
      new Set([
        'auto-heal',
        'integrations',
        'test-map',
        'server-probes',
        'quality-reports',
        'bug-reports',
        'flake-lab',
        'resources',
        'agent-diagnoses',
        'agent-write-log',
        'coverage',
        'assistant',
      ]),
    );
  });

  test('records nothing and marks nothing when no version is supplied', async () => {
    const { capabilities } = await getSetupStatus(db);
    expect(capabilities.every((c) => c.isNew === false)).toBe(true);
    expect(await getAppSetting<string>(db, 'first-run-version')).toBeNull();
  });
});

describe('settings-backed capabilities', () => {
  test('pull-request feedback is active once enabled and something was posted for a run', async () => {
    expect((await activeIds(db)).has('pr-feedback')).toBe(false);
    await setAppSetting(db, 'pr_feedback', { enabled: true });
    expect((await activeIds(db)).has('pr-feedback')).toBe(false);
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
    await db.insert(schema.prFeedbackPosts).values({
      projectId: 1,
      runId: 1,
      provider: 'github',
      repositoryUrl: 'https://github.com/acme/checkout',
      prNumber: 4,
      statuses: ['piwi/tests'],
    });
    expect((await activeIds(db)).has('pr-feedback')).toBe(true);
  });

  test('auto-heal is active once its setting is enabled', async () => {
    expect((await activeIds(db)).has('auto-heal')).toBe(false);
    await setAppSetting(db, 'auto_heal', { enabled: true });
    expect((await activeIds(db)).has('auto-heal')).toBe(true);
  });

  test('issue integrations are active once a connection exists', async () => {
    expect((await activeIds(db)).has('integrations')).toBe(false);
    await db.insert(schema.integrationConnections).values({
      provider: 'jira',
      name: 'Jira',
      baseUrl: 'https://example.atlassian.net',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect((await activeIds(db)).has('integrations')).toBe(true);
  });
});

describe('cached capability evidence', () => {
  /** Run `read` with the clock moved `ms` ahead. */
  async function later<T>(ms: number, read: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + ms);
    try {
      return await read();
    } finally {
      clock.mockRestore();
    }
  }

  test('a capability without evidence shows its first row at once', async () => {
    expect((await getCapabilityEvidence(db)).tags).toBe(false);
    await db.insert(schema.tags).values({ text: 'smoke' });
    expect((await getCapabilityEvidence(db)).tags).toBe(true);
  });

  test('found evidence stands for a minute, unless the read is fresh', async () => {
    await db.insert(schema.tags).values({ text: 'smoke' });
    expect((await getCapabilityEvidence(db)).tags).toBe(true);
    await db.delete(schema.tags);
    expect((await getCapabilityEvidence(db)).tags).toBe(true);
    expect((await later(59_000, () => getCapabilityEvidence(db))).tags).toBe(true);
    expect((await later(61_000, () => getCapabilityEvidence(db))).tags).toBe(false);

    await db.insert(schema.tags).values({ text: 'smoke' });
    expect((await getCapabilityEvidence(db)).tags).toBe(true);
    await db.delete(schema.tags);
    expect((await getCapabilityEvidence(db, undefined, { fresh: true })).tags).toBe(false);
  });

  test('keeps the instance and each project apart', async () => {
    await db.insert(schema.projects).values([
      { id: 1, name: 'with-runs' },
      { id: 2, name: 'without-runs' },
    ]);
    await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date(), duration: 1, totalTests: 1, passedTests: 1 });

    expect((await getCapabilityEvidence(db, 1)).reporter).toBe(true);
    expect((await getCapabilityEvidence(db, 2)).reporter).toBe(false);
    expect((await getCapabilityEvidence(db)).reporter).toBe(true);
  });

  test('the Setup page reads the live state', async () => {
    await db.insert(schema.tags).values({ text: 'smoke' });
    expect(await activeIds(db)).toContain('tags');
    await db.delete(schema.tags);
    expect((await getCapabilityEvidence(db)).tags).toBe(true);
    expect(await activeIds(db)).not.toContain('tags');
  });
});
