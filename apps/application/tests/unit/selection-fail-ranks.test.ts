import { describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { seedFailRanksFixture } from './fail-ranks-fixture';

delete process.env.PIWI_DATABASE_URL;
const { loadSelectionCatalog } = await import('../../shared/handlers/selections');

/**
 * The recency rank of each test's newest failure within its latest results, as
 * `failedInLastRuns` and a `recentFailure` ranking read it, on SQLite: the
 * fixture's rule in memory and the catalog agree on every test.
 */
describe('firstFailRank on SQLite', () => {
  test('ranks the newest failure among the latest results of eligible runs', async () => {
    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    const fixture = await seedFailRanksFixture(db, schema);

    const catalog = await loadSelectionCatalog(db, fixture.projectId, { withFailRanks: true, withAggregates: false });
    const ranks = new Map(catalog.filter((row) => row.firstFailRank != null).map((row) => [row.id, row.firstFailRank]));

    expect(catalog.map((row) => row.id).sort((a, b) => a - b)).toEqual(fixture.testCaseIds);
    expect(ranks).toEqual(fixture.expected);
    const [, , latest, at25, at26, short] = fixture.testCaseIds;
    expect([ranks.get(latest!), ranks.get(at25!), ranks.get(at26!), ranks.get(short!)]).toEqual([1, 25, undefined, 4]);
    expect(fixture.expected.size).toBeGreaterThan(10);
  });
});
