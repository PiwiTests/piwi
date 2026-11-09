import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handlers.
delete process.env.PIWI_DATABASE_URL;
const { getProjectLatestRun, parseLatestRunNames, MAX_LATEST_RUN_NAMES } =
  await import('../../shared/handlers/test-runs');

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60 * 1000);
const reproduceOf42 = (name?: string) => ({
  piwiOrigin: { kind: 'reproduce', ref: '42' },
  ...(name ? { piwiRunRef: name } : {}),
});

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([{ id: 1, name: 'Alpha' }]);
  await db.insert(schema.testRuns).values([
    { id: 10, projectId: 1, status: 'passed', startTime: at(30), origin: 'reproduce', metadata: reproduceOf42() },
    {
      id: 11,
      projectId: 1,
      status: 'failed',
      startTime: at(20),
      origin: 'reproduce',
      metadata: reproduceOf42('desktop-1'),
    },
    {
      id: 12,
      projectId: 1,
      status: 'passed',
      startTime: at(10),
      origin: 'reproduce',
      metadata: reproduceOf42('desktop-2-unattended'),
    },
  ]);
});

describe('the latest run a launcher stamped with an origin and a reference', () => {
  test('is the newest one, whatever name its launcher gave it, when the lookup names none', async () => {
    expect(await getProjectLatestRun(db, 1, { kind: 'reproduce', ref: '42' })).toEqual({
      id: 12,
      status: 'passed',
      name: 'desktop-2-unattended',
    });
  });

  test('skips a run its launcher named otherwise when the lookup names the run', async () => {
    const lookup = (runs: string[]) => getProjectLatestRun(db, 1, { kind: 'reproduce', ref: '42', runs });
    expect(await lookup(['desktop-1', 'desktop-1-unattended'])).toMatchObject({ id: 11, name: 'desktop-1' });
    expect(await lookup(['desktop-2', 'desktop-2-unattended'])).toMatchObject({ id: 12 });
    // A run the reporter recorded no name for still matches.
    expect(await lookup(['desktop-3'])).toEqual({ id: 10, status: 'passed', name: null });
  });
});

describe('parseLatestRunNames', () => {
  test('reads one name or several, and refuses one that is not a ref or too many', () => {
    expect(parseLatestRunNames(undefined)).toBeUndefined();
    expect(parseLatestRunNames('desktop-1')).toEqual(['desktop-1']);
    expect(parseLatestRunNames(['desktop-1', 'desktop-1-unattended'])).toEqual(['desktop-1', 'desktop-1-unattended']);
    expect(parseLatestRunNames(['desktop-1', 'a b'])).toBeNull();
    expect(parseLatestRunNames([1])).toBeNull();
    expect(parseLatestRunNames(Array.from({ length: MAX_LATEST_RUN_NAMES + 1 }, (_, i) => `desktop-${i}`))).toBeNull();
  });
});
