/**
 * The scenario-gap detectors that read code coverage: the functions no suite
 * ran in the default branch's combined coverage, and the functions one test
 * alone runs in the tests' latest coverage.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { configureSqliteConnections, sqliteClientConfig } from '../../server/database/sqlite-connections';
import { migrateToLatest } from './temp-db';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { parseCoverageReportUpload, storeCoverageReport } = await import('../../server/utils/coverage-reports');
const { invalidateCommitCoverage } = await import('../../server/utils/coverage-summary');
const code = await import('../../shared/handlers/code-gaps');
const { computeScenarioGaps } = await import('../../shared/handlers/scenario-gaps');

const COMMIT = '1'.repeat(40);
const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-code-gaps-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeEach(async () => {
  const client = createClient(sqliteClientConfig(`file:${join(tmpDir, `test-${++dbCount}.db`)}`));
  await configureSqliteConnections(client);
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
});

async function upload(files: Array<Record<string, unknown>>) {
  const parsed = parseCoverageReportUpload({ v: 1, commit: COMMIT, suite: 'unit-back', branch: 'main', files });
  if (typeof parsed === 'string') throw new Error(parsed);
  await storeCoverageReport(db as never, 1, parsed);
  invalidateCommitCoverage(1, COMMIT);
}

/** Record that each test's latest coverage ran `functions` of `path` at `blob`. */
async function covered(path: string, blob: string, byTest: Record<number, Array<[number, number]>>) {
  for (const [test, functions] of Object.entries(byTest)) {
    const [fragment] = await db
      .insert(schema.coverageFragments)
      .values({
        projectId: 1,
        hash: `${path}-${blob}-${test}`,
        runtime: 'server',
        path,
        blob,
        functions: functions.map(([a, b]) => `${a}-${b}`).join(','),
        lines: functions.map(([a, b]) => `${a}-${b}`).join(','),
      })
      .returning({ id: schema.coverageFragments.id });
    await db.insert(schema.testCoverage).values({
      projectId: 1,
      testCaseId: Number(test),
      runtime: 'server',
      fragmentId: fragment!.id,
      lastSeenAt: new Date(),
    });
  }
}

describe('code nobody executes', () => {
  test('names the functions no suite ran, and a file recorded by line that none of its lines ran', async () => {
    await upload([
      {
        path: 'src/cart.ts',
        blob: 'a'.repeat(40),
        executable: [[1, 30]],
        lines: [[1, 10]],
        allFunctions: [
          [1, 10],
          [12, 20],
          [22, 30],
        ],
        functions: [[1, 10]],
      },
      { path: 'src/legacy.ts', blob: 'b'.repeat(40), executable: [[1, 8]], lines: [] },
      { path: 'src/done.ts', blob: 'c'.repeat(40), executable: [[1, 4]], lines: [[1, 4]] },
    ]);
    const gaps = code.detectCodeNotExecuted(code.unexecutedFiles(await code.loadDefaultBranchCoverage(db as never, 1)));
    expect(gaps.map((g) => [g.key, g.title])).toEqual([
      ['src/cart.ts', '2 of 3 functions of src/cart.ts no suite runs'],
      ['src/legacy.ts', 'No suite runs src/legacy.ts'],
    ]);
    expect(gaps[0]!.evidence[0]).toContain('lines 12–20, 22–30');
  });
});

describe('single covering function', () => {
  test('names the functions one trusted test runs, or only quarantined tests do', async () => {
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 't.spec.ts', title: 'checkout pays' },
      { id: 2, projectId: 1, filePath: 't.spec.ts', title: 'checkout refunds' },
      { id: 3, projectId: 1, filePath: 't.spec.ts', title: 'flaky coupon' },
    ]);
    await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId: 3 });
    await covered('src/pay.ts', 'd'.repeat(40), {
      1: [
        [1, 5],
        [7, 9],
      ],
      2: [[1, 5]],
      3: [[11, 14]],
    });
    const files = await code.loadSingleCoveredFiles(db as never, 1);
    const [gap] = code.detectSingleCoveringFunction(files);
    expect(gap).toMatchObject({ key: 'src/pay.ts', title: '2 functions of src/pay.ts run under one test only' });
    expect(gap!.evidence).toEqual([
      'Only checkout pays runs the functions at lines 7–9: a second test would make them resilient.',
      'Only quarantined tests run the functions at lines 11–14.',
    ]);
  });
});

describe('the sweep', () => {
  test('raises both kinds of gap, and closes them once the code runs', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await upload([{ path: 'src/legacy.ts', blob: 'b'.repeat(40), executable: [[1, 8]], lines: [] }]);
    await computeScenarioGaps(db as never, 1);
    const open = async () =>
      (await db.select().from(schema.scenarioGaps))
        .filter((g) => g.status === 'open')
        .map((g) => `${g.detector} ${g.key}`);
    expect(await open()).toEqual(['code-not-executed src/legacy.ts']);

    await upload([{ path: 'src/legacy.ts', blob: 'b'.repeat(40), executable: [[1, 8]], lines: [[1, 8]] }]);
    await computeScenarioGaps(db as never, 1);
    expect(await open()).toEqual([]);
  });
});

describe('error path never executed', () => {
  const SOURCE = [
    'export function save(user) {',
    '  if (!user) {',
    '    throw new Error("no user");',
    '  }',
    '  return store(user);',
    '}',
    'export function unused() {',
    '  throw new Error("never");',
    '}',
  ].join('\n');
  const report = (lines: Array<[number, number]>) =>
    upload([
      {
        path: 'src/save.ts',
        blob: 'e'.repeat(40),
        executable: [
          [1, 5],
          [7, 8],
        ],
        lines,
        allFunctions: [
          [1, 6],
          [7, 9],
        ],
        functions: [[1, 6]],
      },
    ]);
  const reader = async (path: string, blob: string) =>
    path === 'src/save.ts' && blob === 'e'.repeat(40) ? SOURCE : null;

  test('names the error path no suite ran inside a function that ran, and not one in a function that never ran', async () => {
    await report([
      [1, 2],
      [5, 5],
    ]);
    const { files, scanned } = await code.loadErrorPathFiles(
      await code.loadDefaultBranchCoverage(db as never, 1),
      reader,
    );
    expect(scanned).toEqual(['src/save.ts']);
    const [gap] = code.detectErrorPathNotExecuted(files);
    expect(gap).toMatchObject({ key: 'src/save.ts', title: '1 error path of src/save.ts never run' });
    expect(gap!.evidence).toEqual(['Line 3 · throw new Error("no user"); · its function ran, this never did.']);
  });

  test('the sweep raises it with a source reader, closes it once the path runs, and leaves it alone without one', async () => {
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await report([
      [1, 2],
      [5, 5],
    ]);
    const errorGaps = async () =>
      (await db.select().from(schema.scenarioGaps))
        .filter((g) => g.detector === 'error-path-not-executed')
        .map((g) => `${g.key} ${g.status}`);
    await computeScenarioGaps(db as never, 1, { readSource: reader });
    expect(await errorGaps()).toEqual(['src/save.ts open']);

    await report([
      [1, 3],
      [5, 5],
    ]);
    await computeScenarioGaps(db as never, 1);
    expect(await errorGaps()).toEqual(['src/save.ts open']);
    await computeScenarioGaps(db as never, 1, { readSource: reader });
    expect(await errorGaps()).toEqual(['src/save.ts closed']);
  });
});
