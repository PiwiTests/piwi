import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { mergeRunCoverageGaps, readRunCoverageGaps } from '#shared/run-coverage-gaps';
import { coverageGapDetail, coverageGapHeadline, dataNoteSentence } from '~/utils/combined-coverage';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { getRunCoverage, storeRunCoverage, storeRunCoverageGaps } = await import('../../server/utils/coverage');
const { loadCommitCoverage, storeCommitTotals } = await import('../../server/utils/coverage-totals');
const { getCoverageSummary, invalidateCommitCoverage } = await import('../../server/utils/coverage-summary');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const COMMIT = '1'.repeat(40);
const BLOB = 'a'.repeat(40);
const ORIGIN = 'http://localhost:5080';
const RESTARTED = { origin: ORIGIN, reason: 'restarted' as const, at: '2026-10-01T10:12:30.000Z' };

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-coverage-gaps-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let db: Db;
beforeEach(async () => {
  db = drizzle(createClient({ url: `file:${join(tmpDir, `test-${++dbCount}.db`)}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  invalidateCommitCoverage(1, COMMIT);
});

async function run(id: number) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(Date.UTC(2026, 9, 1) + id * 1000),
    branch: 'main',
    commit: COMMIT,
    origin: 'ci',
    metadata: { ci: { provider: 'GitHub Actions' }, scm: { commit: COMMIT } },
  });
}

/** A run of the commit whose server coverage of `src/Shop.cs` ran `lines`, of lines 1–10. */
async function coveredRun(id: number, lines: number[][]) {
  await run(id);
  await storeRunCoverage(db as never, id, 1, [
    { path: 'src/Shop.cs', runtime: 'server', blob: BLOB, lines: lines as never, executable: [[1, 10]] },
  ]);
}

describe('readRunCoverageGaps', () => {
  test('keeps valid gaps once, with their origin and restart time normalized', () => {
    expect(
      readRunCoverageGaps([
        { origin: 'http://localhost:5080/api', reason: 'restarted', at: '2026-10-01T12:12:30+02:00' },
        { origin: 'http://localhost:5080', reason: 'restarted', at: '2026-10-01T10:12:30.000Z' },
        { origin: 'https://api.test', reason: 'unreachable', at: '2026-10-01T10:00:00Z' },
        { origin: 'ftp://files.test', reason: 'unreachable' },
        { origin: 'http://x.test', reason: 'crashed' },
        'nope',
      ]),
    ).toEqual([RESTARTED, { origin: 'https://api.test', reason: 'unreachable' }]);
    expect(readRunCoverageGaps(null)).toEqual([]);
    expect(readRunCoverageGaps({ origin: ORIGIN, reason: 'restarted' })).toEqual([]);
  });

  test('merges a shard’s gaps into the stored ones', () => {
    expect(mergeRunCoverageGaps([RESTARTED], [RESTARTED, { origin: 'https://b.test', reason: 'unreachable' }])).toEqual(
      [RESTARTED, { origin: 'https://b.test', reason: 'unreachable' }],
    );
  });
});

describe('a run’s server coverage gaps', () => {
  test('are stored with the run, merged across shards, and read with its coverage', async () => {
    await coveredRun(10, [[1, 3]]);
    await storeRunCoverageGaps(db as never, 10, [RESTARTED]);
    await storeRunCoverageGaps(db as never, 10, [RESTARTED, { origin: 'https://b.test', reason: 'unreachable' }]);

    const [row] = await db
      .select({ gaps: schema.testRuns.serverCoverageGaps })
      .from(schema.testRuns)
      .where(eq(schema.testRuns.id, 10));
    expect(row!.gaps).toEqual([RESTARTED, { origin: 'https://b.test', reason: 'unreachable' }]);
    expect((await getRunCoverage(db as never, 10, { limit: 0 }))!.incomplete).toEqual(row!.gaps);
  });

  test('a run with none reads as whole', async () => {
    await coveredRun(10, [[1, 3]]);
    expect(await storeRunCoverageGaps(db as never, 10, [])).toEqual([]);
    expect((await getRunCoverage(db as never, 10))!.incomplete).toEqual([]);
  });
});

describe('the e2e suite of a commit whose run lost part of its server coverage', () => {
  test('is incomplete, with a note naming the run, when it is the commit’s only run', async () => {
    await coveredRun(10, [[1, 3]]);
    await storeRunCoverageGaps(db as never, 10, [RESTARTED]);

    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT))!;
    const e2e = coverage.combined.suites.find((s) => s.name === 'e2e')!;
    expect(e2e).toMatchObject({ incomplete: true, executedLines: 3, executableLines: 10 });

    const summary = (await getCoverageSummary(db as never, 1, { commit: COMMIT, branch: null, folder: '' }))!;
    // No upload named the commit's files; the generic note on an incomplete suite gives way to the runs'.
    expect(summary.notes.filter((n) => n.kind !== 'no-inventory')).toEqual([
      {
        kind: 'runs-incomplete',
        runs: [{ id: 10, reasons: ['restarted'], restartedAt: RESTARTED.at }],
        completeRuns: 0,
      },
    ]);

    const stored = await storeCommitTotals(db as never, 1, COMMIT);
    expect(stored).not.toBeNull();
    const [row] = await db
      .select({ incomplete: schema.coverageTotals.incomplete })
      .from(schema.coverageTotals)
      .where(eq(schema.coverageTotals.suite, 'e2e'));
    expect(row!.incomplete).toBe(true);
  });

  test('joins the union beside a complete run, which keeps the suite whole', async () => {
    await coveredRun(10, [[1, 3]]);
    await coveredRun(11, [[5, 6]]);
    await storeRunCoverageGaps(db as never, 11, [RESTARTED]);

    const coverage = (await loadCommitCoverage(db as never, 1, COMMIT))!;
    // The incomplete run adds the lines it ran: the union is never lower than the complete run alone.
    expect(coverage.combined.suites.find((s) => s.name === 'e2e')).toMatchObject({
      incomplete: false,
      executedLines: 5,
    });
    const summary = (await getCoverageSummary(db as never, 1, { commit: COMMIT, branch: null, folder: '' }))!;
    // No upload named the commit's files; the generic note on an incomplete suite gives way to the runs'.
    expect(summary.notes.filter((n) => n.kind !== 'no-inventory')).toEqual([
      {
        kind: 'runs-incomplete',
        runs: [{ id: 11, reasons: ['restarted'], restartedAt: RESTARTED.at }],
        completeRuns: 1,
      },
    ]);
  });
});

describe('the words of a run’s coverage gaps', () => {
  const text = (parts: ReturnType<typeof dataNoteSentence>) =>
    parts.map((p) => (typeof p === 'string' ? p : 'run' in p ? `#${p.run}` : p.commit)).join('');

  test('flag the run and say what each backend lost', () => {
    expect(coverageGapHeadline([RESTARTED])).toBe('Coverage incomplete: the backend restarted during the run');
    expect(coverageGapHeadline([{ origin: ORIGIN, reason: 'unreachable' }])).toBe(
      'Coverage incomplete: the backend was unreachable at the end of the run',
    );
    expect(coverageGapHeadline([])).toBeNull();
    expect(coverageGapDetail(RESTARTED, () => '10:12')).toBe(
      'http://localhost:5080 restarted at about 10:12: the lines the tests ran are kept; what it ran outside a request before the restart is missing.',
    );
  });

  test('note the commit’s incomplete runs, linking each', () => {
    const run = { id: 12, reasons: ['restarted' as const], restartedAt: null };
    expect(dataNoteSentence({ kind: 'runs-incomplete', runs: [run], completeRuns: 0 }, null)).toContainEqual({
      run: 12,
    });
    expect(text(dataNoteSentence({ kind: 'runs-incomplete', runs: [run], completeRuns: 0 }, null))).toBe(
      'e2e: incomplete: the backend restarted during run #12. The lines the tests ran are kept; what the backend ran outside a request before the restart is missing, so e2e may read low.',
    );
    expect(
      text(
        dataNoteSentence(
          { kind: 'runs-incomplete', runs: [run, { ...run, id: 14, reasons: ['unreachable'] }], completeRuns: 2 },
          null,
        ),
      ),
    ).toBe(
      'e2e: a backend restarted or was unreachable in runs #12, #14. Their lines still count; 2 complete runs keep the suite whole.',
    );
  });
});
