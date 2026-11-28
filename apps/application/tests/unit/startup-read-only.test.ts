/**
 * A server that starts read-only makes none of its startup passes: they wait for the first call of `getDatabase` that
 * finds the instance writable, which waits for them as startup does.
 */
import { afterAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { holdOperatorLimits } from '#shared/operator-limits';
import { migrateToLatest } from './temp-db';

const passes = vi.hoisted(() => ({ backfillAliasSamples: vi.fn(async () => 0), recluster: vi.fn() }));
vi.mock('#shared/handlers/failure-cluster-recluster', () => ({
  ALIAS_SAMPLES_BACKFILLED_SETTING: 'failure_cluster_alias_samples_backfilled_at',
  backfillAliasSamples: passes.backfillAliasSamples,
  reclusterFailureFingerprints: async () => {
    passes.recluster();
    return { updated: 0, merged: 0 };
  },
}));

const dataDir = mkdtempSync(join(tmpdir(), 'piwi-startup-read-only-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

test('the startup passes wait until the instance is writable, then run once', async () => {
  const path = join(dataDir, 'piwi.db');
  const client = createClient({ url: `file:${path}` });
  const seeded = drizzle(client, { schema });
  await migrateToLatest(seeded);
  await seeded.insert(schema.appSettings).values({ key: 'operator_limits', value: { readOnly: true } });
  client.close();

  delete process.env.PIWI_DATABASE_URL;
  process.env.PIWI_DATABASE_PATH = path;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const { getDatabase } = await import('../../server/database');
    await getDatabase();
    expect(passes.recluster).not.toHaveBeenCalled();
    await getDatabase();
    expect(passes.recluster).not.toHaveBeenCalled();

    holdOperatorLimits({});
    await Promise.all([getDatabase(), getDatabase()]);
    expect(passes.recluster).toHaveBeenCalledTimes(1);
    await getDatabase();
    expect(passes.recluster).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
    delete process.env.PIWI_DATABASE_PATH;
  }
});
