import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';

// Run deletion also clears each run's storage directory; no files exist here.
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;

const rollups = await import('../../shared/handlers/analytics/rollups');
const { groupRows } = await import('../../shared/handlers/analytics/scalar-rows');
const { deleteRunsByIds, deleteRunsOlderThan } = await import('../../server/utils/retention');
const { releaseRun, keepRun } = await import('../../shared/handlers/run-keep');
const { dayKey } = await import('../../shared/handlers/analytics/common');
const { PROBE_RUN_METADATA_KEY } = await import('../../shared/handlers/probes');
const { runOrigin } = await import('../../shared/run-eligibility');
const { rollupMetricValue } = await import('../../shared/handlers/analytics/metric-values');

const DAY_MS = 24 * 60 * 60 * 1000;

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  // A file database: libSQL runs a transaction on its own connection, which an
  // in-memory database does not share.
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-rollups-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout' },
    { id: 2, name: 'search' },
  ]);
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'a' });
});

afterEach(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RunSeed {
  projectId?: number;
  daysAgo: number;
  hour?: number;
  status?: string;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  flakyTests?: number;
  /** Null for a run that never reported one (an interrupted run). */
  duration?: number | null;
  /** Null for a run with no measured test durations. */
  p90TestDuration?: number | null;
  environment?: string | null;
  branch?: string | null;
  isFullRun?: number;
  metadata?: Record<string, unknown>;
  cases?: Array<{ status: string; duration: number; wastedTimeMs?: number; isNewRegression?: number }>;
}

/** Insert a run at `hour`:00 UTC, `daysAgo` days ago, and its executions. */
async function seedRun(seed: RunSeed): Promise<number> {
  const day = new Date(Date.now() - seed.daysAgo * DAY_MS);
  day.setUTCHours(seed.hour ?? 10, 0, 0, 0);
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId: seed.projectId ?? 1,
      status: seed.status ?? 'passed',
      startTime: day,
      duration: seed.duration === undefined ? 60_000 : seed.duration,
      totalTests: seed.totalTests ?? 10,
      passedTests: seed.passedTests ?? 10,
      failedTests: seed.failedTests ?? 0,
      flakyTests: seed.flakyTests ?? 0,
      environment: seed.environment ?? null,
      branch: seed.branch ?? null,
      isFullRun: seed.isFullRun ?? 1,
      metadata: seed.metadata,
      origin: runOrigin(seed.metadata),
      avgTestDuration: seed.p90TestDuration === null ? null : 1_000,
      p90TestDuration: seed.p90TestDuration === undefined ? 2_000 : seed.p90TestDuration,
    })
    .returning({ id: schema.testRuns.id });
  if (seed.cases?.length) {
    await db.insert(schema.testRunsCases).values(
      seed.cases.map((c) => ({
        testRunId: row!.id,
        testCaseId: 1,
        status: c.status,
        duration: c.duration,
        wastedTimeMs: c.wastedTimeMs ?? 0,
        isNewRegression: c.isNewRegression ?? 0,
      })),
    );
  }
  return row!.id;
}

async function rollupRows() {
  return db.select().from(schema.analyticsDailyRollups);
}

function wholeRange(fromDaysAgo = 400) {
  return {
    projectIds: 'all' as const,
    fromDay: dayKey(Date.now() - fromDaysAgo * DAY_MS),
    toDay: dayKey(Date.now()),
    fullRunsOnly: false,
  };
}

/** The rows summed into one totals object, as the analytics handlers sum them. */
function sumRows(rows: Awaited<ReturnType<typeof rollups.readRollupSeries>>) {
  return groupRows(rows, () => 'all').get('all') ?? rollups.emptyRollupTotals();
}

async function dayTotals(daysAgo: number) {
  const day = dayKey(Date.now() - daysAgo * DAY_MS);
  const rows = await rollups.readRollupSeries(db as any, { ...wholeRange(), fromDay: day, toDay: day });
  return sumRows(rows);
}

describe('the ingest hook', () => {
  test('recomputes the cell from the raw rows, so a second call changes nothing', async () => {
    const id = await seedRun({
      daysAgo: 1,
      passedTests: 8,
      failedTests: 2,
      status: 'failed',
      cases: [
        { status: 'failed', duration: 30_000, wastedTimeMs: 5_000, isNewRegression: 1 },
        { status: 'passed', duration: 10_000 },
      ],
    });
    await rollups.upsertDailyRollup(db as any, id);
    const first = await rollupRows();
    await rollups.upsertDailyRollup(db as any, id);
    const second = await rollupRows();

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      part: 'retained',
      runs: 1,
      failedRuns: 1,
      passedTests: 8,
      failedTests: 2,
      waitMs: 5_000,
      failedExecMs: 30_000,
      newRegressions: 1,
      durationMs: 60_000,
    });
    expect({ ...second[0], computedAt: null }).toEqual({ ...first[0], computedAt: null });
  });

  test('an average divides by the runs that have the value, so runs without one do not pull it down', async () => {
    // Ten 10-minute runs, then ten interrupted runs that reported no duration and no test durations.
    for (let i = 0; i < 10; i++) await seedRun({ daysAgo: 1, duration: 600_000 });
    for (let i = 0; i < 10; i++)
      await seedRun({ daysAgo: 1, status: 'interrupted', duration: null, p90TestDuration: null });
    await rollups.backfillDailyRollups(db as any);

    const totals = await dayTotals(1);
    expect(totals).toMatchObject({ runs: 20, durationRuns: 10, testDurationRuns: 10, durationMs: 6_000_000 });
    expect(rollupMetricValue('average-run-duration', totals, null)).toBe(600_000);
    expect(rollupMetricValue('average-p90-test-duration', totals, null)).toBe(2_000);
    // A day with no measured duration has no average, rather than 0.
    const none = { ...rollups.emptyRollupTotals(), runs: 3 };
    expect(rollupMetricValue('average-run-duration', none, null)).toBeNull();
  });

  test('splits cells by environment, branch and run kind, and leaves probe and unfinished runs out', async () => {
    await seedRun({ daysAgo: 1, environment: 'staging', branch: 'main' });
    await seedRun({ daysAgo: 1, environment: 'staging', branch: 'main' });
    await seedRun({ daysAgo: 1, branch: 'feature/x' });
    await seedRun({ daysAgo: 1, isFullRun: 0 });
    await seedRun({ daysAgo: 1, status: 'running' });
    const probe = await seedRun({ daysAgo: 1, status: 'failed', metadata: { [PROBE_RUN_METADATA_KEY]: true } });
    await rollups.upsertDailyRollup(db as any, probe);

    const rows = await rollupRows();
    const byCell = rows.map((r) => `${r.environment}|${r.branch}|${r.fullRun}:${r.runs}`).sort();
    expect(byCell).toEqual(['staging|main|1:2', '|feature/x|1:1', '||0:1'].sort());
  });
});

describe('the rollups agree with the stored runs', () => {
  test('backfilled sums equal the sums of the raw runs, for any seed', async () => {
    let seedValue = 42;
    const random = () => {
      seedValue = (seedValue * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seedValue / 2_147_483_648;
    };
    const statuses = ['passed', 'failed', 'timedout', 'interrupted', 'running'];
    for (let i = 0; i < 120; i++) {
      const total = 5 + Math.floor(random() * 20);
      const passed = Math.floor(random() * (total + 1));
      await seedRun({
        projectId: random() < 0.5 ? 1 : 2,
        daysAgo: Math.floor(random() * 60),
        hour: Math.floor(random() * 24),
        status: statuses[Math.floor(random() * statuses.length)],
        totalTests: total,
        passedTests: passed,
        failedTests: total - passed,
        flakyTests: Math.floor(random() * 3),
        duration: Math.floor(random() * 600_000),
        environment: random() < 0.3 ? 'staging' : null,
        branch: random() < 0.5 ? 'main' : null,
        isFullRun: random() < 0.8 ? 1 : 0,
      });
    }
    await rollups.backfillDailyRollups(db as any);

    const raw = await db.select().from(schema.testRuns);
    const counted = raw.filter((r) => ['passed', 'failed', 'timedout', 'interrupted'].includes(r.status));
    const series = await rollups.readRollupSeries(db as any, wholeRange());
    const sum = sumRows(series);

    expect(sum.runs).toBe(counted.length);
    expect(sum.passedTests).toBe(counted.reduce((a, r) => a + r.passedTests, 0));
    expect(sum.totalTests).toBe(counted.reduce((a, r) => a + r.totalTests, 0));
    expect(sum.flakyTests).toBe(counted.reduce((a, r) => a + r.flakyTests, 0));
    expect(sum.durationMs).toBe(counted.reduce((a, r) => a + (r.duration ?? 0), 0));
    expect(sum.passedRuns).toBe(counted.filter((r) => r.status === 'passed').length);
    expect(sum.maxTotalTests).toBe(Math.max(...counted.map((r) => r.totalTests)));

    for (const run of counted.slice(0, 10)) {
      const day = dayKey(run.startTime);
      const [row] = await rollups.readRollupSeries(db as any, {
        ...wholeRange(),
        projectIds: [run.projectId],
        fromDay: day,
        toDay: day,
      });
      const sameDay = counted.filter((r) => r.projectId === run.projectId && dayKey(r.startTime) === day);
      expect(row!.runs).toBe(sameDay.length);
      expect(row!.passedTests).toBe(sameDay.reduce((a, r) => a + r.passedTests, 0));
    }
  });

  test('the reconcile repairs a cell the hook missed and drops a row whose runs are gone', async () => {
    const id = await seedRun({ daysAgo: 2 });
    await rollups.upsertDailyRollup(db as any, id);
    await seedRun({ daysAgo: 2 });
    await db.delete(schema.testRuns).where(eq(schema.testRuns.id, id));
    await seedRun({ daysAgo: 20 });

    await rollups.reconcileRecentRollups(db as any, 7);
    const rows = await rollupRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toBe(1);
    expect(rows[0]!.day).toBe(dayKey(Date.now() - 2 * DAY_MS));
  });
});

/**
 * A database whose first read of the raw runs (the recompute's) resolves, then
 * holds the recompute until `gate` opens, so a second recompute can run whole
 * in between. `read` settles once that first read is done.
 */
function pauseAfterRunsRead(target: typeof db, gate: Promise<void>) {
  let armed = true;
  let markRead!: () => void;
  const read = new Promise<void>((resolve) => (markRead = resolve));
  const hold = (builder: any): any =>
    new Proxy(builder, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop);
        if (prop === 'then')
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            obj
              .then((rows: unknown) => {
                markRead();
                return gate.then(() => rows);
              })
              .then(resolve, reject);
        return typeof value === 'function' ? (...args: unknown[]) => hold(value.apply(obj, args)) : value;
      },
    });
  const paused = new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop);
      if (prop !== 'select') return typeof value === 'function' ? value.bind(obj) : value;
      return (fields?: Record<string, unknown>) => {
        const builder = (value as any).call(obj, fields);
        if (!armed || !fields || !('isFullRun' in fields)) return builder;
        armed = false;
        return hold(builder);
      };
    },
  });
  return { paused, read };
}

describe('overlapping recomputes', () => {
  test('a recompute never deletes a cell another one wrote after it read the runs', async () => {
    await seedRun({ daysAgo: 1, environment: 'staging' });
    const late = await seedRun({ daysAgo: 1, environment: 'prod', status: 'running' });
    await rollups.backfillDailyRollups(db as any);
    const day = dayKey(Date.now() - DAY_MS);

    // Recompute A reads the day's runs while the prod run is still running, then waits.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { paused, read } = pauseAfterRunsRead(db, gate);
    const a = rollups.recomputeRollupCells(paused as any, [{ projectId: 1, day }]);
    await read;

    // The prod run finishes and recompute B writes its cell.
    await db.update(schema.testRuns).set({ status: 'passed' }).where(eq(schema.testRuns.id, late));
    await rollups.upsertDailyRollup(db as any, late);
    open();
    await a;

    const retained = (await rollupRows()).filter((r) => r.part === 'retained');
    expect(retained.map((r) => r.environment).sort()).toEqual(['prod', 'staging']);
  });
});

describe('deleting runs', () => {
  test('age-based deletion moves the numbers to the archived row; a kept run stays retained', async () => {
    const kept = await seedRun({ daysAgo: 100, passedTests: 7, failedTests: 3, status: 'failed' });
    await seedRun({
      daysAgo: 100,
      passedTests: 10,
      cases: [{ status: 'failed', duration: 4_000, wastedTimeMs: 1_000 }],
    });
    await seedRun({ daysAgo: 100, passedTests: 9, failedTests: 1, status: 'failed' });
    await keepRun(db as any, kept, { source: 'user' });
    await rollups.backfillDailyRollups(db as any);
    const before = await dayTotals(100);

    const result = await deleteRunsOlderThan(dbc, 30);
    expect(result.deletedRuns).toBe(2);
    expect(result.skippedKept).toBe(1);

    const after = await dayTotals(100);
    expect(after).toEqual(before);
    const parts = (await rollupRows()).map((r) => `${r.part}:${r.runs}`).sort();
    expect(parts).toEqual(['archived:2', 'retained:1']);

    // A retried prune finds nothing left to add.
    await deleteRunsOlderThan(dbc, 30);
    expect(await dayTotals(100)).toEqual(before);

    // Releasing the kept run and deleting it by hand removes only its numbers.
    await releaseRun(db as any, kept);
    await deleteRunsByIds(dbc, [kept]);
    const corrected = await dayTotals(100);
    expect(corrected.runs).toBe(2);
    expect(corrected.passedTests).toBe(19);
    expect(corrected.failedTests).toBe(1);
    expect(corrected.waitMs).toBe(1_000);
    expect((await rollupRows()).map((r) => r.part)).toEqual(['archived']);
  });

  test('a purge in slices, one transaction each, keeps every day exact', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(await seedRun({ daysAgo: 100, hour: 8 + i, passedTests: 10 - i, failedTests: i }));
    for (let i = 0; i < 3; i++) ids.push(await seedRun({ daysAgo: 101, hour: 9 + i, duration: 30_000 }));
    await rollups.backfillDailyRollups(db as any);
    const before = [await dayTotals(100), await dayTotals(101)];

    // Slices of two runs: day 100 spans three transactions, and each commit leaves it exact.
    await deleteRunsByIds(dbc, ids, { archiveRollups: true, sliceRuns: 2 });
    expect([await dayTotals(100), await dayTotals(101)]).toEqual(before);
    expect((await rollupRows()).every((r) => r.part === 'archived')).toBe(true);
  });

  test('deleting one run by hand is a correction: its numbers leave the day', async () => {
    const a = await seedRun({ daysAgo: 3, passedTests: 10 });
    await seedRun({ daysAgo: 3, passedTests: 4, failedTests: 6, status: 'failed' });
    await rollups.backfillDailyRollups(db as any);

    await deleteRunsByIds(dbc, [a]);
    const totals = await dayTotals(3);
    expect(totals.runs).toBe(1);
    expect(totals.passedTests).toBe(4);
    expect((await rollupRows()).every((r) => r.part === 'retained')).toBe(true);
  });
});

const exporter = await import('../../shared/handlers/analytics/rollup-export');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');

describe('the rollup export', () => {
  test('one row per cell over the period, across chunks of days, only for projects the caller can open', async () => {
    const first = await seedRun({ daysAgo: 80, environment: 'staging', branch: '=HYPERLINK("x")' });
    const second = await seedRun({ daysAgo: 2, projectId: 2 });
    await rollups.upsertDailyRollup(db as any, first);
    await rollups.upsertDailyRollup(db as any, second);
    const scope = parseAnalyticsScope({ period: 'last-90d', allBranches: 'true', fullRunsOnly: 'false' });

    const all = await exporter.collectRollupExport(db as any, scope, 'all');
    expect(all.map((r) => [r.project, r.environment])).toEqual([
      ['checkout', 'staging'],
      ['search', ''],
    ]);
    expect(all[0]!.runs).toBe(1);

    const restricted = await exporter.collectRollupExport(db as any, scope, new Set([2]));
    expect(restricted.map((r) => r.projectId)).toEqual([2]);
    expect(await exporter.collectRollupExport(db as any, scope, new Set())).toEqual([]);

    const csv = exporter.rollupCsvHeader() + exporter.rollupCsvRows(all);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(exporter.ROLLUP_EXPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    // A branch name is run-derived: a spreadsheet must never run it as a formula.
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
