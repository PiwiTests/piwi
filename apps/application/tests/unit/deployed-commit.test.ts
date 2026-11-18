import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { runsDeployedCommits } = await import('../../shared/handlers/deployed-commit');
const { saveEnvironmentSnapshots } = await import('../../shared/handlers/environment-snapshots');
const { createMarker } = await import('../../shared/handlers/markers');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const SHOP = 1;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 18, 12);

async function environment(key: string, appFromCheckout: boolean) {
  const [row] = await db
    .insert(schema.environments)
    .values({ projectId: SHOP, key, keyFold: key, name: key, appFromCheckout })
    .returning();
  return row!.id;
}

async function run(environmentId: number | null, startTime: Date) {
  const [row] = await db
    .insert(schema.testRuns)
    .values({ projectId: SHOP, status: 'passed', startTime, environmentId })
    .returning();
  return { id: row!.id, environmentId, startTime };
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: SHOP, name: 'shop' });
});

describe('the deployed commit of a run', () => {
  test('a server snapshot names it first, else the latest deploy marker before the run', async () => {
    const staging = await environment('staging', false);
    await createMarker(db as never, SHOP, {
      label: 'Deploy 41',
      occurredAt: new Date(NOW - 2 * DAY),
      category: 'deploy',
      environment: 'staging',
      commit: 'AAAAAAA1',
    });
    await createMarker(db as never, SHOP, {
      label: 'Deploy 42',
      occurredAt: new Date(NOW - DAY),
      category: 'deploy',
      environment: 'staging',
      commit: 'bbbbbbb2',
    });
    await createMarker(db as never, SHOP, {
      label: 'Deploy 43, after the run',
      occurredAt: new Date(NOW + DAY),
      category: 'deploy',
      environment: 'staging',
      commit: 'ccccccc3',
    });
    const reported = await run(staging, new Date(NOW));
    await saveEnvironmentSnapshots(db as never, reported.id, [
      { kind: 'server', v: 1, origin: 'https://staging.shop.test', appCommit: 'DDDDDDD4' },
    ]);
    const deployed = await run(staging, new Date(NOW));
    const before = await run(staging, new Date(NOW - 3 * DAY));

    const commits = await runsDeployedCommits(db as never, [reported, deployed, before]);
    expect(commits.get(reported.id)).toEqual({
      commit: 'ddddddd4',
      source: 'server',
      origin: 'https://staging.shop.test',
    });
    expect(commits.get(deployed.id)).toMatchObject({ commit: 'bbbbbbb2', source: 'marker' });
    expect(commits.get(before.id)).toBeNull();
  });

  test('an environment built from the checkout, or none, has no deployed commit', async () => {
    const local = await environment('local', true);
    await createMarker(db as never, SHOP, {
      label: 'Deploy',
      occurredAt: new Date(NOW - DAY),
      category: 'deploy',
      environment: 'local',
      commit: 'aaaaaaa1',
    });
    const fromCheckout = await run(local, new Date(NOW));
    const unlabeled = await run(null, new Date(NOW));
    const commits = await runsDeployedCommits(db as never, [fromCheckout, unlabeled]);
    expect([...commits.values()]).toEqual([null, null]);
  });
});
