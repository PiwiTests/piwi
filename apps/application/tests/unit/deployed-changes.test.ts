import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';

delete process.env.PIWI_DATABASE_URL;
const { clusterFirstFailingDeploy, deployedChanges, verdictDeployOf, runChangeCoverageNote } =
  await import('../../shared/handlers/deployed-changes');
const { getEnvironmentActivity } = await import('../../shared/handlers/environment-activity');
const { environmentContextSection } = await import('../../shared/handlers/environment-context');
const { computeRunInsights } = await import('../../shared/handlers/run-insights');
const { computeReproduceContext } = await import('../../shared/handlers/reproduce');
const { createMarker } = await import('../../shared/handlers/markers');
const { saveEnvironmentSnapshots } = await import('../../shared/handlers/environment-snapshots');
const { runEnvironmentFacts } = await import('../../shared/handlers/environments');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const SHOP = 1;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 18, 12);
const REPOSITORY = 'https://github.com/acme/shop';

async function environment(key: string, appFromCheckout: boolean) {
  const [row] = await db
    .insert(schema.environments)
    .values({ projectId: SHOP, key, keyFold: key, name: key[0]!.toUpperCase() + key.slice(1), appFromCheckout })
    .returning();
  return row!.id;
}

async function run(environmentId: number | null, startTime: number, status = 'passed', commit = 'aaaaaaa0') {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId: SHOP,
      status,
      isFullRun: 1,
      startTime: new Date(startTime),
      environmentId,
      environment: environmentId == null ? null : 'staging',
      metadata: { scm: { commit, remoteUrl: `${REPOSITORY}.git`, branch: 'main' } },
    })
    .returning();
  return { id: row!.id, projectId: SHOP, environmentId, startTime: new Date(startTime), metadata: row!.metadata };
}

async function deploy(label: string, at: number, commit: string | null, environmentKey = 'staging') {
  await createMarker(db as never, SHOP, {
    label,
    occurredAt: new Date(at),
    category: 'deploy',
    environment: environmentKey,
    commit,
  });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: SHOP, name: 'shop', repositoryUrl: REPOSITORY });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: SHOP, filePath: 'tests/cart.spec.ts', title: 'adds to cart' },
    { id: 2, projectId: SHOP, filePath: 'tests/cart.spec.ts', title: 'checks out' },
  ]);
});

describe('what changed in a deployed environment between two runs', () => {
  test('the deployed commit of each, the application range in the project repository, and the deploys between', async () => {
    const staging = await environment('staging', false);
    await deploy('Deploy 1', NOW - 10 * HOUR, '1111111a');
    const baseline = await run(staging, NOW - 9 * HOUR);
    await deploy('Deploy 2', NOW - 5 * HOUR, '2222222b');
    await deploy('Deploy 3', NOW - 2 * HOUR, '3333333c');
    const failing = await run(staging, NOW - HOUR, 'failed');

    const changes = await deployedChanges(db as never, failing, baseline);
    expect(changes?.environment.name).toBe('Staging');
    expect(changes?.current).toMatchObject({ commit: '3333333c', source: 'marker', markerLabel: 'Deploy 3' });
    expect(changes?.baseline).toMatchObject({ commit: '1111111a', source: 'marker' });
    expect(changes?.range).toMatchObject({
      fromSha: '1111111a',
      toSha: '3333333c',
      repositoryUrl: REPOSITORY,
      gitCommand: 'git log --oneline 1111111a..3333333c',
    });
    expect(changes?.deploys.map((d) => d.label)).toEqual(['Deploy 2', 'Deploy 3']);
    expect(changes?.more).toBe(false);
  });

  test('a server snapshot wins, the same deployed commit makes no range, and an unknown one leaves it out', async () => {
    const staging = await environment('staging', false);
    const baseline = await run(staging, NOW - 9 * HOUR);
    await deploy('Deploy 2', NOW - 5 * HOUR, '2222222b');
    const failing = await run(staging, NOW - HOUR, 'failed');
    await saveEnvironmentSnapshots(db as never, baseline.id, [
      { kind: 'server', v: 1, origin: 'https://staging.shop.test', appCommit: '2222222bffff' },
    ]);

    const same = await deployedChanges(db as never, failing, baseline);
    expect(same?.baseline).toMatchObject({ source: 'server', origin: 'https://staging.shop.test' });
    expect(same?.range).toBeNull();

    const before = await run(staging, NOW - 20 * HOUR);
    const unknown = await deployedChanges(db as never, before, null);
    expect(unknown?.current).toBeNull();
    expect(unknown?.range).toBeNull();
  });

  test('the run page names the deployed commit and where it comes from', async () => {
    const staging = await environment('staging', false);
    await deploy('Deploy 2', NOW - 5 * HOUR, '2222222b');
    const failing = await run(staging, NOW - HOUR, 'failed');
    const [row] = await db.select().from(schema.environments).where(eq(schema.environments.id, staging));
    const [stored] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, failing.id));
    const facts = await runEnvironmentFacts(db as never, stored as never, row as never);
    expect(facts.environmentAppFromCheckout).toBe(false);
    expect(facts.deployedCommit).toMatchObject({ commit: '2222222b', source: 'marker', markerLabel: 'Deploy 2' });
  });

  test('an environment built from the checkout, or none, has no deployed changes', async () => {
    const local = await environment('local', true);
    expect(await deployedChanges(db as never, await run(local, NOW), null)).toBeNull();
    expect(await deployedChanges(db as never, await run(null, NOW), null)).toBeNull();
  });
});

describe("a cluster's first failing deploy", () => {
  async function cluster(firstSeenRunId: number) {
    const [row] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: SHOP,
        fingerprint: `f${firstSeenRunId}`,
        signature: 'Error',
        firstSeenRunId,
        lastSeenRunId: firstSeenRunId,
      })
      .returning();
    return row!;
  }

  test('the deploys between the last run of the environment where its tests passed and the first failing run', async () => {
    const staging = await environment('staging', false);
    const production = await environment('production', false);
    await deploy('Deploy 1', NOW - 10 * HOUR, '1111111a');
    const passed = await run(staging, NOW - 9 * HOUR);
    const elsewhere = await run(production, NOW - 3 * HOUR);
    await deploy('Deploy 2', NOW - 5 * HOUR, '2222222b');
    await deploy('Deploy 3', NOW - 2 * HOUR, '3333333c');
    const failed = await run(staging, NOW - HOUR, 'failed');
    const found = await cluster(failed.id);
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts([
        { testRunId: passed.id, testCaseId: 1, status: 'passed' },
        { testRunId: elsewhere.id, testCaseId: 1, status: 'passed' },
        { testRunId: failed.id, testCaseId: 1, status: 'failed', failureClusterId: found.id },
      ]),
    );

    const first = await clusterFirstFailingDeploy(db as never, found);
    expect(first).toMatchObject({ firstFailingRunId: failed.id, lastPassingRunId: passed.id });
    expect(first?.deploys.map((d) => d.label)).toEqual(['Deploy 2', 'Deploy 3']);
    expect(first?.range).toMatchObject({ fromShort: '1111111', toShort: '3333333' });

    expect(await verdictDeployOf(db as never, failed, found)).toEqual({
      environment: 'Staging',
      commit: '3333333c',
      label: 'Deploy 3',
      noDeploySinceLastPass: false,
    });

    const section = await environmentContextSection(db as never, { runId: failed.id, cluster: found });
    expect(section?.markdown).toContain('## Environment Under Test');
    expect(section?.markdown).toContain('Deployed commit of run');
    expect(section?.markdown).toContain('First failing deploy: Deploy 3 (3333333)');
    expect(section?.markdown).toContain('git log --oneline 1111111a..3333333c');
    expect(section?.coverage).toEqual({
      name: 'Staging',
      appFromCheckout: false,
      deployedCommit: '3333333c',
      deploys: 2,
    });
  });

  test('says no deploy happened since the last pass, and names none for an environment built from the checkout', async () => {
    const staging = await environment('staging', false);
    const local = await environment('local', true);
    await deploy('Deploy 1', NOW - 10 * HOUR, '1111111a');
    const passed = await run(staging, NOW - 9 * HOUR);
    const failed = await run(staging, NOW - HOUR, 'failed');
    const found = await cluster(failed.id);
    const localFailed = await run(local, NOW - HOUR, 'failed');
    const localCluster = await cluster(localFailed.id);
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts([
        { testRunId: passed.id, testCaseId: 2, status: 'passed' },
        { testRunId: failed.id, testCaseId: 2, status: 'failed', failureClusterId: found.id },
        { testRunId: localFailed.id, testCaseId: 1, status: 'failed', failureClusterId: localCluster.id },
      ]),
    );

    expect(await verdictDeployOf(db as never, failed, found)).toEqual({
      environment: 'Staging',
      commit: '1111111a',
      label: null,
      noDeploySinceLastPass: true,
    });
    expect(await clusterFirstFailingDeploy(db as never, localCluster)).toBeNull();
    expect(await verdictDeployOf(db as never, localFailed, localCluster)).toBeNull();
    const section = await environmentContextSection(db as never, { runId: localFailed.id, cluster: localCluster });
    expect(section?.markdown).toContain('Built from the checkout');
  });
});

describe('the Changes tab, the bisect and change coverage of a deployed environment', () => {
  test('the insights carry the deployed changes and the bisect the deploys between the two runs', async () => {
    const staging = await environment('staging', false);
    await deploy('Deploy 1', NOW - 10 * HOUR, '1111111a');
    const baseline = await run(staging, NOW - 9 * HOUR, 'passed', 'aaaaaaa1');
    await deploy('Deploy 2', NOW - 5 * HOUR, '2222222b');
    const failing = await run(staging, NOW - HOUR, 'failed', 'aaaaaaa2');
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts([
        { testRunId: baseline.id, testCaseId: 1, status: 'passed' },
        { testRunId: failing.id, testCaseId: 1, status: 'failed' },
      ]),
    );

    const insights = await computeRunInsights(db as never, failing.id);
    expect(insights.baseline?.id).toBe(baseline.id);
    expect(insights.commitRange).toMatchObject({ fromShort: 'aaaaaaa', toShort: 'aaaaaaa' });
    expect(insights.deployed?.range).toMatchObject({ fromSha: '1111111a', toSha: '2222222b' });
    expect(insights.deployed?.deploys.map((d) => d.label)).toEqual(['Deploy 2']);

    const { bisect } = await computeReproduceContext(db as never, {
      runId: failing.id,
      cases: [{ filePath: 'tests/cart.spec.ts', title: 'adds to cart', line: 3, projectName: null }],
      browserName: 'chromium',
      verifyCommand: 'npx playwright test tests/cart.spec.ts:3',
    });
    expect(bisect.available).toBe(true);
    expect(bisect.deployed).toMatchObject({ environment: 'Staging', more: false });
    expect(bisect.deployed?.deploys.map((d) => d.label)).toEqual(['Deploy 2']);
    if (bisect.available) expect(bisect.explanation).toContain('never one of the application');

    expect(await runChangeCoverageNote(db as never, failing, 'aaaaaaa2')).toContain('deployed at 2222222');
    expect(await runChangeCoverageNote(db as never, failing, '2222222bcafe')).toBeNull();
  });
});

describe("an environment's activity", () => {
  test('its last run, last incident, deploys and the versions its recent runs ran against', async () => {
    const staging = await environment('staging', false);
    await deploy('Deploy 1', NOW - 10 * HOUR, '1111111a');
    const first = await run(staging, NOW - 9 * HOUR);
    const second = await run(staging, NOW - 8 * HOUR, 'failed');
    await db
      .update(schema.testRuns)
      .set({
        metadata: {
          incident: { rule: 'host-unreachable', reason: 'staging.shop.test refused every connection.', firstRunId: 0 },
        },
      })
      .where(eq(schema.testRuns.id, second.id));
    await deploy('Deploy 2', NOW - 5 * HOUR, '2222222b');
    const third = await run(staging, NOW - 4 * HOUR);
    await saveEnvironmentSnapshots(db as never, third.id, [
      { kind: 'server', v: 1, origin: 'https://staging.shop.test', appVersion: '2.4.1' },
    ]);

    const activity = await getEnvironmentActivity(db as never, SHOP, staging, new Date(NOW));
    expect(activity?.lastRun?.id).toBe(third.id);
    expect(activity?.lastIncident).toMatchObject({
      runId: second.id,
      reason: 'staging.shop.test refused every connection.',
    });
    expect(activity?.deploys.map((d) => d.label)).toEqual(['Deploy 2', 'Deploy 1']);
    expect(activity?.versions).toMatchObject([
      { commit: '2222222b', appVersions: ['2.4.1'], lastRunId: third.id, runs: 1 },
      { commit: '1111111a', appVersions: [], lastRunId: second.id, runs: 2 },
    ]);
    expect(first.id).toBeLessThan(second.id);
    expect(await getEnvironmentActivity(db as never, 2, staging)).toBeNull();
  });
});
