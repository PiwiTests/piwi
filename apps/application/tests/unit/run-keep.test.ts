import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

// Run deletion also clears each run's storage directory; no files exist here.
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;

const { deleteRunsOlderThan, retentionMinRuns } = await import('../../server/utils/retention');
const { parseTestRunPatch, patchTestRun } = await import('../../shared/handlers/test-runs');
const { applyReporterKeep, isRunKept, keepRun, releaseRun } = await import('../../shared/handlers/run-keep');
const { createMarker, updateMarker, deleteMarker } = await import('../../shared/handlers/markers');
const { listKeptRuns } = await import('../../shared/handlers/projects');
const { deleteUserRecord } = await import('../../shared/handlers/users');
const { getStorageAnalysis } = await import('../../shared/handlers/admin-storage');
const { normalizeKeepReason, KEEP_REASON_MAX_LENGTH } = await import('../../shared/run-keep');

const DAY_MS = 24 * 60 * 60 * 1000;

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-run-keep-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values([
    { id: 1, name: 'p1' },
    { id: 2, name: 'p2' },
  ]);
});

afterEach(async () => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.PIWI_RETENTION_MIN_RUNS;
});

/** Insert a finished run that started `daysAgo` days ago; returns its id. */
async function run(projectId: number, daysAgo: number, extra: Partial<typeof schema.testRuns.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'passed',
      startTime: new Date(Date.now() - daysAgo * DAY_MS),
      ...extra,
    })
    .returning({ id: schema.testRuns.id });
  return row!.id;
}

async function remainingIds(): Promise<number[]> {
  const rows = await db.select({ id: schema.testRuns.id }).from(schema.testRuns);
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function keepState(id: number) {
  const [row] = await db
    .select({
      keptAt: schema.testRuns.keptAt,
      keptBy: schema.testRuns.keptBy,
      keepSource: schema.testRuns.keepSource,
      keepReason: schema.testRuns.keepReason,
    })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, id));
  return row!;
}

describe('deleteRunsOlderThan', () => {
  test('never deletes a kept run, and counts it as skipped', async () => {
    const oldKept = await run(1, 100, { keptAt: new Date(), keepSource: 'user' });
    const oldPlain = await run(1, 100);
    const recent = await run(1, 1);

    const result = await deleteRunsOlderThan(dbc, 30);

    expect(result).toMatchObject({ deletedRuns: 1, skippedKept: 1, skippedNewest: 0 });
    expect(await remainingIds()).toEqual([oldKept, recent].sort((a, b) => a - b));
    expect(await remainingIds()).not.toContain(oldPlain);
  });

  test('keeps the newest runs of each project when a floor is set', async () => {
    // Project 1 stopped reporting: every run is old. Project 2 is active.
    const p1 = [await run(1, 200), await run(1, 150), await run(1, 120), await run(1, 90)];
    const p2Old = [await run(2, 300), await run(2, 250)];
    const p2Recent = [await run(2, 2), await run(2, 1)];

    const result = await deleteRunsOlderThan(dbc, 30, { keepNewestPerProject: 2 });

    // Project 1 keeps its two newest (90 and 120 days old); project 2's two
    // newest are recent anyway, so both of its old runs go.
    expect(result).toMatchObject({ deletedRuns: 4, skippedKept: 0, skippedNewest: 2 });
    expect(await remainingIds()).toEqual([p1[2]!, p1[3]!, ...p2Recent].sort((a, b) => a - b));
    for (const id of [p1[0]!, p1[1]!, ...p2Old]) expect(await remainingIds()).not.toContain(id);
  });

  test('ranks the floor over every run, kept ones included', async () => {
    const kept = await run(1, 50, { keptAt: new Date(), keepSource: 'user' });
    const older = await run(1, 60);
    const oldest = await run(1, 70);

    const result = await deleteRunsOlderThan(dbc, 30, { keepNewestPerProject: 2 });

    // The kept run is the newest and fills one of the two floor slots.
    expect(result).toMatchObject({ deletedRuns: 1, skippedKept: 1, skippedNewest: 1 });
    expect(await remainingIds()).toEqual([kept, older].sort((a, b) => a - b));
    expect(await remainingIds()).not.toContain(oldest);
  });

  test('reads the floor from PIWI_RETENTION_MIN_RUNS, ignoring junk', () => {
    expect(retentionMinRuns()).toBe(0);
    process.env.PIWI_RETENTION_MIN_RUNS = '5';
    expect(retentionMinRuns()).toBe(5);
    process.env.PIWI_RETENTION_MIN_RUNS = '-3';
    expect(retentionMinRuns()).toBe(0);
    process.env.PIWI_RETENTION_MIN_RUNS = 'lots';
    expect(retentionMinRuns()).toBe(0);
  });
});

describe('parseTestRunPatch', () => {
  test('accepts label, keep and a reason alongside keep: true', () => {
    expect(parseTestRunPatch({ label: 'v1' })).toEqual({ label: 'v1' });
    expect(parseTestRunPatch({ keep: true, keepReason: 'release' })).toEqual({ keep: true, keepReason: 'release' });
    expect(parseTestRunPatch({ keep: false })).toEqual({ keep: false });
  });

  test('rejects malformed bodies with a message', () => {
    expect(parseTestRunPatch({})).toBe('No fields to update');
    expect(parseTestRunPatch(null)).toBe('No fields to update');
    expect(parseTestRunPatch({ keep: 'yes' })).toBe('keep must be a boolean');
    expect(parseTestRunPatch({ keepReason: 'why' })).toBe('keepReason is only accepted with keep: true');
    expect(parseTestRunPatch({ keep: false, keepReason: 'why' })).toBe('keepReason is only accepted with keep: true');
    expect(parseTestRunPatch({ label: 3 })).toBe('label must be a string or null');
  });
});

describe('keeping and releasing a run', () => {
  test('patchTestRun keeps with author and reason, and releases', async () => {
    await db.insert(schema.users).values({ id: 7, username: 'alice', password: 'x', role: 'member' });
    const id = await run(1, 10);

    await patchTestRun(db as any, id, { keep: true, keepReason: '  v2.3.1 release  ' }, { userId: 7 });
    const kept = await keepState(id);
    expect(kept.keptAt).toBeInstanceOf(Date);
    expect(kept).toMatchObject({ keptBy: 7, keepSource: 'user', keepReason: 'v2.3.1 release' });

    await patchTestRun(db as any, id, { keep: false });
    expect(await keepState(id)).toEqual({ keptAt: null, keptBy: null, keepSource: null, keepReason: null });
  });

  test('keeping a kept run only replaces its reason, and only when one is given', async () => {
    const id = await run(1, 10);
    await keepRun(db as any, id, { source: 'reporter' });
    const first = await keepState(id);

    await keepRun(db as any, id, { source: 'user', userId: null });
    expect(await keepState(id)).toEqual(first);

    await keepRun(db as any, id, { source: 'user', reason: 'audit' });
    expect(await keepState(id)).toEqual({ ...first, keepReason: 'audit' });
  });

  test('applyReporterKeep keeps only on an explicit true', async () => {
    const id = await run(1, 10);
    await applyReporterKeep(db as any, id, 'true');
    await applyReporterKeep(db as any, id, undefined);
    expect(await isRunKept(db as any, id)).toBe(false);

    await applyReporterKeep(db as any, id, true);
    expect(await keepState(id)).toMatchObject({ keptBy: null, keepSource: 'reporter', keepReason: null });
  });

  test('a deleted user leaves the keep in place without an author', async () => {
    await db.insert(schema.users).values({ id: 8, username: 'bob', password: 'x', role: 'member' });
    const id = await run(1, 10);
    await keepRun(db as any, id, { source: 'user', userId: 8 });

    await deleteUserRecord(db as any, 8);

    expect(await keepState(id)).toMatchObject({ keptBy: null, keepSource: 'user' });
    expect(await isRunKept(db as any, id)).toBe(true);
  });

  test('normalizeKeepReason trims, blanks to null and caps the length', () => {
    expect(normalizeKeepReason('  hi ')).toBe('hi');
    expect(normalizeKeepReason('   ')).toBeNull();
    expect(normalizeKeepReason(undefined)).toBeNull();
    expect(normalizeKeepReason('x'.repeat(500))).toHaveLength(KEEP_REASON_MAX_LENGTH);
  });
});

describe('release markers', () => {
  test('a release marker linked to a run keeps it, and removing the marker releases it', async () => {
    const id = await run(1, 10);
    const { marker } = await createMarker(db as any, 1, {
      label: 'v2.3.1',
      occurredAt: new Date(),
      category: 'release',
      runId: id,
    });
    expect(await keepState(id)).toMatchObject({ keepSource: 'marker', keepReason: 'v2.3.1' });

    await deleteMarker(db as any, marker.id);
    expect(await isRunKept(db as any, id)).toBe(false);
  });

  test('recategorizing the marker away from release releases the run, and back keeps it', async () => {
    const id = await run(1, 10);
    const { marker } = await createMarker(db as any, 1, {
      label: 'v2.3.1',
      occurredAt: new Date(),
      category: 'release',
      runId: id,
    });

    await updateMarker(db as any, marker.id, { category: 'deploy' });
    expect(await isRunKept(db as any, id)).toBe(false);

    await updateMarker(db as any, marker.id, { category: 'release' });
    expect(await isRunKept(db as any, id)).toBe(true);
  });

  test('a marker never releases a keep a person or the reporter made', async () => {
    const id = await run(1, 10);
    await keepRun(db as any, id, { source: 'user', reason: 'audit' });
    const { marker } = await createMarker(db as any, 1, {
      label: 'v2.3.1',
      occurredAt: new Date(),
      category: 'release',
      runId: id,
    });
    expect(await keepState(id)).toMatchObject({ keepSource: 'user', keepReason: 'audit' });

    await deleteMarker(db as any, marker.id);
    expect(await keepState(id)).toMatchObject({ keepSource: 'user', keepReason: 'audit' });
  });

  test('a marker of another category, or with no run, keeps nothing', async () => {
    const id = await run(1, 10);
    await createMarker(db as any, 1, { label: 'deploy', occurredAt: new Date(), category: 'deploy', runId: id });
    await createMarker(db as any, 1, { label: 'v1', occurredAt: new Date(), category: 'release' });
    expect(await isRunKept(db as any, id)).toBe(false);
  });

  test('releasing a marker-kept run by hand is allowed', async () => {
    const id = await run(1, 10);
    await createMarker(db as any, 1, { label: 'v1', occurredAt: new Date(), category: 'release', runId: id });
    await releaseRun(db as any, id);
    expect(await isRunKept(db as any, id)).toBe(false);
  });
});

describe('listing and measuring kept runs', () => {
  test('listKeptRuns returns only the project’s kept runs, newest first, with the total', async () => {
    const older = await run(1, 40, { keptAt: new Date(), keepSource: 'user' });
    const newer = await run(1, 20, { keptAt: new Date(), keepSource: 'reporter' });
    await run(1, 5);
    await run(2, 30, { keptAt: new Date(), keepSource: 'user' });

    const { items, total } = await listKeptRuns(db as any, 1);

    expect(total).toBe(2);
    expect(items.map((r: { id: number }) => r.id)).toEqual([newer, older]);
    expect(items[0]).toMatchObject({ keepSource: 'reporter', reports: [], browsers: [] });
  });

  test('the storage analysis counts kept runs and the files they own', async () => {
    const kept = await run(1, 40, { keptAt: new Date(), keepSource: 'user' });
    const plain = await run(1, 20);
    await db.insert(schema.files).values([
      { testRunId: kept, type: 'report', path: 'project-1/run-a/index.html', size: 1000 },
      { testRunId: kept, type: 'attachment', path: 'project-1/run-a/shot.png', size: 500 },
      { testRunId: plain, type: 'report', path: 'project-1/run-b/index.html', size: 9000 },
    ]);

    const analysis = await getStorageAnalysis(db as any);

    expect(analysis.kept).toEqual({ runs: 1, files: 2, bytes: 1500 });
  });
});
