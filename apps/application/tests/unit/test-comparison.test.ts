/**
 * Compare with team instance, on the team instance: the test a connected desktop app names is found as ingestion
 * matches one, its history holds the CI's results of every environment and, marked local, the teammates' own runs,
 * never a private, lab or investigation run; the cluster of the same fingerprint counts what the CI saw of it; the
 * closest CI pass is on the local commit, else in the local environment; and the route refuses a key that cannot
 * compare, an owner who cannot read the project and a project that declines it.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { apiError } from '../../server/utils/api-error';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_AUTH_ENABLED = 'true';

type Db = ReturnType<typeof drizzle<typeof schema>>;
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  node: { req: { headers: Record<string, string> }; res: object };
}
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.node.req.headers[name]);
vi.stubGlobal('readBody', async () => ({}));

const { generateApiKey } = await import('../../server/utils/auth');
const { compareTestWithTeam } = await import('../../server/utils/test-comparison');
const { testComparisonQuerySchema } = await import('#shared/test-comparison');
const { FINGERPRINT_VERSION } = await import('#shared/error-fingerprint');
const { setInstanceDecisions, setProjectDecisions } = await import('#shared/handlers/capabilities');
const route = (await import('../../server/api/run-targets/projects/[id]/test-comparison.get')).default as unknown as (
  event: FakeEvent,
) => Promise<unknown>;
const self = (await import('../../server/api/run-targets/self.put')).default as unknown as (
  event: FakeEvent,
) => Promise<{ compares: boolean | null }>;

const FINGERPRINT = 'a'.repeat(64);
const ALIAS = 'b'.repeat(64);
const COMMIT = 'c0ffee0000000000000000000000000000000001';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T08:00:00Z');

let db: Db;
let userId: number;
let shop: number;
let hidden: number;
let checkout: number;
let cart: number;
let clusterId: number;
let integrationId: number;

const query = (values: Record<string, string | number> = {}) =>
  testComparisonQuerySchema.parse({ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', ...values });

async function run(values: Partial<typeof schema.testRuns.$inferInsert> & { startTime: Date }) {
  const [row] = await db
    .insert(schema.testRuns)
    .values({ projectId: shop, status: 'passed', origin: 'ci', branch: 'main', ...values })
    .returning();
  return row!.id;
}

async function execution(testRunId: number, values: Partial<typeof schema.testRunsCases.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.testRunsCases)
    .values({ testRunId, testCaseId: checkout, status: 'passed', browserName: 'chromium', ...values })
    .returning();
  return row!.id;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [user] = await db.insert(schema.users).values({ username: 'robin', password: 'x', role: 'member' }).returning();
  userId = user!.id;
  const projects = await db
    .insert(schema.projects)
    .values([{ name: 'shop' }, { name: 'hidden' }])
    .returning();
  shop = projects[0]!.id;
  hidden = projects[1]!.id;
  await db.insert(schema.roleBindings).values({ userId, projectId: shop, role: 'viewer' });
  const environments = await db
    .insert(schema.environments)
    .values([
      { projectId: shop, key: 'mco', keyFold: 'mco', name: 'MCO' },
      { projectId: shop, key: 'integration', keyFold: 'integration', name: 'Integration' },
    ])
    .returning();
  integrationId = environments[1]!.id;
  const cases = await db
    .insert(schema.testCases)
    .values([
      { projectId: shop, filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', externalId: 'SHOP-12' },
      { projectId: shop, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
    ])
    .returning();
  checkout = cases[0]!.id;
  cart = cases[1]!.id;
});

describe('the test', () => {
  test('is found by its external ID first, then by its file, describe path and title', async () => {
    const renamed = await compareTestWithTeam(db, shop, query({ externalId: 'SHOP-12', title: 'renamed' }));
    expect(renamed.testCase).toMatchObject({ id: checkout, path: `/test-cases/${checkout}` });
    const byKey = await compareTestWithTeam(db, shop, query());
    expect(byKey.testCase?.id).toBe(checkout);
    const elsewhere = await compareTestWithTeam(db, shop, query({ filePath: 'tests/other.spec.ts' }));
    expect(elsewhere.testCase).toBeNull();
    expect(elsewhere.history).toEqual([]);
  });

  test('never matches by file and title a test case that holds another external ID', async () => {
    expect((await compareTestWithTeam(db, shop, query({ externalId: 'SHOP-99' }))).testCase).toBeNull();
  });

  test('among test cases of the same file and title, takes the one holding an ID, then the newest', async () => {
    const [older, newer] = await db
      .insert(schema.testCases)
      .values([
        { projectId: shop, filePath: 'tests/twice.spec.ts', title: 'twice' },
        { projectId: shop, filePath: 'tests/twice.spec.ts', title: 'twice' },
      ])
      .returning();
    const twice = query({ filePath: 'tests/twice.spec.ts', title: 'twice' });
    expect((await compareTestWithTeam(db, shop, twice)).testCase?.id).toBe(newer!.id);
    await db.update(schema.testCases).set({ externalId: 'SHOP-7' }).where(eq(schema.testCases.id, older!.id));
    expect((await compareTestWithTeam(db, shop, twice)).testCase?.id).toBe(older!.id);
  });

  test('takes a title as Playwright names it, empty or with spaces at its ends', async () => {
    await db.insert(schema.testCases).values([
      { projectId: shop, filePath: 'tests/edge.spec.ts', title: '' },
      { projectId: shop, filePath: 'tests/edge.spec.ts', title: ' spaced ' },
    ]);
    expect(
      (await compareTestWithTeam(db, shop, query({ filePath: 'tests/edge.spec.ts', title: '' }))).testCase,
    ).not.toBeNull();
    expect(
      (await compareTestWithTeam(db, shop, query({ filePath: 'tests/edge.spec.ts', title: ' spaced ' }))).testCase,
    ).not.toBeNull();
    expect(
      testComparisonQuerySchema.safeParse({ filePath: 'a.spec.ts', title: 'a', commit: 'a'.repeat(64) }).success,
    ).toBe(true);
  });

  test('reads the local run’s label as a run’s, an alias naming its environment', async () => {
    await db
      .update(schema.environments)
      .set({ aliases: ['int'] })
      .where(eq(schema.environments.id, integrationId));
    expect((await compareTestWithTeam(db, shop, query({ environment: 'int' }))).localEnvironment).toBe('integration');
    expect((await compareTestWithTeam(db, shop, query({ environment: 'recette' }))).localEnvironment).toBe('recette');
    expect((await compareTestWithTeam(db, shop, query())).localEnvironment).toBeNull();
  });

  test('says nothing of the Playwright project when none was sent', async () => {
    await execution(await run({ startTime: new Date(T0) }));
    expect((await compareTestWithTeam(db, shop, query())).playwrightProjectMatched).toBeNull();
    expect(
      (await compareTestWithTeam(db, shop, query({ playwrightProject: 'chromium' }))).playwrightProjectMatched,
    ).toBe(true);
  });

  test('says whether it is quarantined', async () => {
    await db.insert(schema.quarantinedTests).values({ projectId: shop, testCaseId: checkout });
    expect((await compareTestWithTeam(db, shop, query())).testCase?.quarantined).toBe(true);
  });
});

describe('the history', () => {
  test('holds the CI of every environment and the teammates’ runs apart, never a private, lab or investigation run', async () => {
    const mco = await run({ origin: 'ci', environment: 'mco', startTime: new Date(T0) });
    const integration = await run({ origin: 'ci-rerun', environment: 'Integration', startTime: new Date(T0 + DAY) });
    const teammate = await run({ origin: 'local', startTime: new Date(T0 + 2 * DAY) });
    const requested = await run({ origin: 'request', startTime: new Date(T0 + 3 * DAY) });
    const lab = await run({ origin: 'flake-lab', startTime: new Date(T0 + 3 * DAY) });
    const bisect = await run({ origin: 'bisect', startTime: new Date(T0 + 3 * DAY) });
    await db.update(schema.testRuns).set({ environmentId: integrationId }).where(eq(schema.testRuns.id, integration));
    for (const id of [mco, integration, teammate, requested, lab, bisect]) await execution(id);

    const { history } = await compareTestWithTeam(db, shop, query());
    expect(history.map((r) => [r.runId, r.source, r.environment])).toEqual([
      [teammate, 'local', null],
      [integration, 'ci', 'integration'],
      [mco, 'ci', 'mco'],
    ]);
  });

  test('holds final attempts alone, with their flaky verdict', async () => {
    const id = await run({ startTime: new Date(T0) });
    await execution(id, { status: 'failed', retries: 0, finalAttempt: false });
    await execution(id, { status: 'passed', retries: 1, passedAfterFailure: true });
    const { history } = await compareTestWithTeam(db, shop, query());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'passed', flaky: true });
  });

  test('is the local Playwright project’s, unless the CI never ran the test there', async () => {
    const id = await run({ startTime: new Date(T0) });
    await execution(id, { browserName: 'chromium' });
    await execution(id, { browserName: 'firefox', status: 'failed' });
    const chromium = await compareTestWithTeam(db, shop, query({ playwrightProject: 'chromium' }));
    expect(chromium.playwrightProjectMatched).toBe(true);
    expect(chromium.history.map((r) => r.playwrightProject)).toEqual(['chromium']);
    const webkit = await compareTestWithTeam(db, shop, query({ playwrightProject: 'webkit' }));
    expect(webkit.playwrightProjectMatched).toBe(false);
    expect(webkit.history).toHaveLength(2);
  });

  test('holds each CI environment’s latest results, however busy another one is', async () => {
    const nightly = await run({ environment: 'integration', startTime: new Date(T0) });
    await execution(nightly);
    for (let i = 1; i <= 45; i++) {
      await execution(await run({ environment: 'mco', startTime: new Date(T0 + i * 60_000) }));
    }
    const answer = await compareTestWithTeam(db, shop, query({ environment: 'integration' }));
    expect(answer.history.filter((r) => r.environment === 'integration').map((r) => r.runId)).toEqual([nightly]);
    expect(answer.closestPass?.runId).toBe(nightly);
  });

  test('marks a run of an environment incident', async () => {
    await execution(
      await run({
        status: 'failed',
        startTime: new Date(T0),
        metadata: { incident: { reason: 'The staging database was down' } },
      }),
      {
        status: 'failed',
      },
    );
    const [result] = (await compareTestWithTeam(db, shop, query())).history;
    expect(result?.incident).toBe(true);
  });

  test('holds the results on the local commit even when the latest are newer', async () => {
    const old = await run({ commit: COMMIT, startTime: new Date(T0) });
    await execution(old);
    for (let i = 1; i <= 45; i++) await execution(await run({ startTime: new Date(T0 + i * 60_000) }));
    const { history } = await compareTestWithTeam(db, shop, query({ commit: COMMIT.slice(0, 12) }));
    expect(history.some((r) => r.runId === old)).toBe(true);
    expect(history).toHaveLength(41);
  });
});

describe('the cluster', () => {
  beforeEach(async () => {
    const ci = await run({ status: 'failed', startTime: new Date(T0) });
    const local = await run({ status: 'failed', origin: 'local', startTime: new Date(T0 + DAY) });
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: shop,
        fingerprint: FINGERPRINT,
        signature: 'Timeout',
        firstSeenRunId: ci,
        lastSeenRunId: local,
      })
      .returning();
    clusterId = cluster!.id;
    await db
      .insert(schema.failureClusterAliases)
      .values({ projectId: shop, fingerprint: ALIAS, clusterId, createdAt: new Date(T0) });
    await execution(ci, { status: 'failed', failureClusterId: clusterId });
    await execution(ci, { status: 'failed', failureClusterId: clusterId, testCaseId: cart });
    await execution(local, { status: 'failed', failureClusterId: clusterId });
  });

  test('is found by its fingerprint or an alias, and counts what the CI saw of it', async () => {
    for (const fingerprint of [FINGERPRINT, ALIAS]) {
      const { cluster } = await compareTestWithTeam(
        db,
        shop,
        query({ fingerprint, fingerprintVersion: FINGERPRINT_VERSION }),
      );
      expect(cluster).toMatchObject({
        id: clusterId,
        ciOccurrences: 2,
        ciTests: 2,
        ciFirstSeen: T0,
        ciLastSeen: T0,
        path: `/failure-clusters/${clusterId}`,
      });
    }
  });

  test('is matched for a test the project does not hold', async () => {
    const answer = await compareTestWithTeam(
      db,
      shop,
      query({ filePath: 'tests/new.spec.ts', fingerprint: FINGERPRINT, fingerprintVersion: FINGERPRINT_VERSION }),
    );
    expect(answer.testCase).toBeNull();
    expect(answer.cluster?.id).toBe(clusterId);
  });

  test('counts a CI failure a retry passed', async () => {
    const flaky = await run({ startTime: new Date(T0 + 2 * DAY) });
    await execution(flaky, { status: 'failed', retries: 0, finalAttempt: false, failureClusterId: clusterId });
    await execution(flaky, { status: 'passed', retries: 1, passedAfterFailure: true });
    const { cluster } = await compareTestWithTeam(
      db,
      shop,
      query({ fingerprint: FINGERPRINT, fingerprintVersion: FINGERPRINT_VERSION }),
    );
    expect(cluster).toMatchObject({ ciOccurrences: 3, ciLastSeen: T0 + 2 * DAY });
  });

  test('follows the route a triager gave the test’s failures of that fingerprint', async () => {
    const ci = await run({ status: 'failed', startTime: new Date(T0 + 2 * DAY) });
    const [moved] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: shop,
        fingerprint: 'd'.repeat(64),
        signature: 'Moved',
        firstSeenRunId: ci,
        lastSeenRunId: ci,
      })
      .returning();
    await db
      .insert(schema.failureClusterTestRoutes)
      .values({ projectId: shop, fingerprint: FINGERPRINT, testCaseId: checkout, clusterId: moved!.id });
    const { cluster } = await compareTestWithTeam(
      db,
      shop,
      query({ fingerprint: FINGERPRINT, fingerprintVersion: FINGERPRINT_VERSION }),
    );
    expect(cluster).toMatchObject({ id: moved!.id, title: 'Moved' });
  });

  test('names the environments the CI saw it in, and leaves out an environment incident', async () => {
    const outage = await run({
      status: 'failed',
      environment: 'mco',
      startTime: new Date(T0 + 5 * DAY),
      metadata: { incident: { reason: 'The staging database was down' } },
    });
    await execution(outage, { status: 'failed', failureClusterId: clusterId });
    const inMco = await run({ status: 'failed', environment: 'mco', startTime: new Date(T0 + 2 * DAY) });
    await execution(inMco, { status: 'failed', failureClusterId: clusterId });
    const { cluster } = await compareTestWithTeam(
      db,
      shop,
      query({ fingerprint: FINGERPRINT, fingerprintVersion: FINGERPRINT_VERSION }),
    );
    expect(cluster).toMatchObject({ ciOccurrences: 3, ciLastSeen: T0 + 2 * DAY });
    expect(cluster?.ciEnvironments).toContain('mco');
  });

  test('a fingerprint sent without its version is not compared', async () => {
    const answer = await compareTestWithTeam(db, shop, query({ fingerprint: FINGERPRINT }));
    expect(answer.fingerprintComparable).toBe(false);
    expect(answer.cluster).toBeNull();
  });

  test('is not matched across fingerprint versions', async () => {
    const answer = await compareTestWithTeam(
      db,
      shop,
      query({ fingerprint: FINGERPRINT, fingerprintVersion: FINGERPRINT_VERSION + 1 }),
    );
    expect(answer.fingerprintComparable).toBe(false);
    expect(answer.cluster).toBeNull();
  });
});

describe('the closest CI pass', () => {
  test('is on the local commit, else in the local environment, and carries its snapshot', async () => {
    const onCommit = await run({
      commit: COMMIT,
      environment: 'mco',
      startTime: new Date(T0),
      playwrightVersion: '1.58.0',
    });
    const inIntegration = await run({
      environment: 'integration',
      startTime: new Date(T0 + DAY),
      playwrightVersion: '1.60.0',
    });
    const newest = await run({ environment: 'mco', startTime: new Date(T0 + 2 * DAY) });
    const failed = await run({ environment: 'integration', status: 'failed', startTime: new Date(T0 + 3 * DAY) });
    await execution(onCommit);
    await execution(inIntegration);
    await execution(newest);
    await execution(failed, { status: 'failed' });

    const sameCommit = await compareTestWithTeam(db, shop, query({ commit: COMMIT }));
    expect(sameCommit.closestPass).toMatchObject({ runId: onCommit, sameCommit: true, environment: 'mco' });
    expect(sameCommit.closestPass?.snapshot.values.playwrightVersion).toBe('1.58.0');

    // The local environment comes before the local commit: two deployed environments do not run the same app.
    const sameEnvironment = await compareTestWithTeam(db, shop, query({ commit: COMMIT, environment: 'Integration' }));
    expect(sameEnvironment.closestPass).toMatchObject({ runId: inIntegration, sameCommit: false });

    const latest = await compareTestWithTeam(db, shop, query());
    expect(latest.closestPass?.runId).toBe(newest);
  });

  test('reads the environment a run’s label resolved to, whatever label it reported', async () => {
    const mcoId = (await db.select().from(schema.environments).where(eq(schema.environments.key, 'mco')))[0]!.id;
    const labelled = await run({ environment: 'MCO', environmentId: mcoId, startTime: new Date(T0) });
    const integration = await run({ environment: 'integration', startTime: new Date(T0 + DAY) });
    await execution(labelled);
    await execution(integration);
    const answer = await compareTestWithTeam(db, shop, query({ environment: 'mco' }));
    expect(answer.closestPass).toMatchObject({ runId: labelled, environment: 'mco' });
  });

  test('on the local commit, in the local environment first', async () => {
    const mco = await run({ commit: COMMIT, environment: 'mco', startTime: new Date(T0) });
    const integration = await run({ commit: COMMIT, environment: 'integration', startTime: new Date(T0 + DAY) });
    await execution(mco);
    await execution(integration);
    const answer = await compareTestWithTeam(db, shop, query({ commit: COMMIT, environment: 'mco' }));
    expect(answer.closestPass).toMatchObject({ runId: mco, sameCommit: true });
  });

  test('a short commit stored by the CI matches the full local one', async () => {
    const short = await run({ commit: COMMIT.slice(0, 7), startTime: new Date(T0) });
    await execution(short);
    await execution(await run({ startTime: new Date(T0 + DAY) }));
    const answer = await compareTestWithTeam(db, shop, query({ commit: COMMIT }));
    expect(answer.closestPass).toMatchObject({ runId: short, sameCommit: true });
    expect(answer.history.map((r) => r.runId)).toContain(short);
  });

  test('is never a teammate’s run', async () => {
    await execution(await run({ origin: 'local', startTime: new Date(T0) }));
    expect((await compareTestWithTeam(db, shop, query())).closestPass).toBeNull();
  });
});

describe('the route', () => {
  async function key(permissions: string[], kind: 'desktop' | 'runner' = 'desktop') {
    const made = generateApiKey();
    const [row] = await db
      .insert(schema.apiKeys)
      .values({ userId, name: 'Piwi Desktop on LAPTOP-42', keyHash: made.hash, keyPrefix: made.prefix, permissions })
      .returning();
    await db.insert(schema.runTargets).values({ userId, apiKeyId: row!.id, kind, deviceName: 'LAPTOP-42' });
    return made.plaintext;
  }

  const event = (plaintext: string, projectId: number, extra: Record<string, string> = {}): FakeEvent => ({
    context: {},
    params: { id: String(projectId) },
    query: { filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', ...extra },
    node: { req: { headers: { authorization: `Bearer ${plaintext}` } }, res: {} },
  });
  const call = (plaintext: string, projectId: number, extra: Record<string, string> = {}) =>
    route(event(plaintext, projectId, extra));

  test('the describe answer says whether the key compares, false for a desktop app’s key made before it could', async () => {
    expect((await self(event(await key(['run:receive', 'project:read']), shop))).compares).toBe(true);
    expect((await self(event(await key(['run:receive']), shop))).compares).toBe(false);
    expect((await self(event(await key(['run:receive'], 'runner'), shop))).compares).toBeNull();
    await setInstanceDecisions(db as never, { 'team-comparison': 'declined' });
    expect((await self(event(await key(['run:receive', 'project:read']), shop))).compares).toBeNull();
  });

  test('answers a key that may compare, on a project its owner reads', async () => {
    const answer = (await call(await key(['run:receive', 'project:read']), shop)) as { testCase: { id: number } };
    expect(answer.testCase.id).toBe(checkout);
  });

  test('refuses a key that cannot compare, with its own error code', async () => {
    await expect(call(await key(['run:receive']), shop)).rejects.toMatchObject({
      statusCode: 403,
      data: { errorCode: 'RUN_TARGET_KEY_CANNOT_COMPARE' },
    });
  });

  test('refuses a project its owner cannot read', async () => {
    await expect(call(await key(['run:receive', 'project:read']), hidden)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('refuses a project that declines Compare with team instance, or an instance that does', async () => {
    const plaintext = await key(['run:receive', 'project:read']);
    const off = { statusCode: 403, data: { errorCode: 'TEAM_COMPARISON_OFF' } };
    await setProjectDecisions(db as never, shop, { 'team-comparison': 'declined' });
    await expect(call(plaintext, shop)).rejects.toMatchObject(off);
    await setProjectDecisions(db as never, shop, { 'team-comparison': null });
    await setInstanceDecisions(db as never, { 'team-comparison': 'declined' });
    await expect(call(plaintext, shop)).rejects.toMatchObject(off);
  });

  test('refuses a query that names no test', async () => {
    const plaintext = await key(['run:receive', 'project:read']);
    await expect(call(plaintext, shop, { filePath: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call(plaintext, shop, { commit: 'not-a-commit' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
