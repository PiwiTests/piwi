import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { configureSqliteConnections, sqliteClientConfig } from '../../server/database/sqlite-connections';
import { demoResourceReport } from '../../shared/demo/demo-resources.mjs';
import { identityFile, resourceFingerprint } from '../../shared/resource-fingerprint.mjs';
import type { WireResourceFinding, WireResourceReport } from '../../shared/types';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { saveResourceReportPart } = await import('../../shared/handlers/resource-reports');
const { getRunResources } = await import('../../shared/handlers/run-resources');
const {
  recordRunResourceFindings,
  runFindingsNovelty,
  runClosedFindings,
  runLeakFacts,
  listResourceFindings,
  pairMoved,
  rekeyResourceFindingsOnce,
  FIXED_AFTER_CLEAN_RUNS,
} = await import('../../shared/handlers/resource-findings');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-resource-findings-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(async () => {
  // Configured as the server configures its client: writes wait for an open transaction.
  const client = createClient(sqliteClientConfig(`file:${join(tmpDir, `test-${++dbCount}.db`)}`));
  await configureSqliteConnections(client);
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout', defaultBranch: 'main' });
  nextRun = 100;
  nextCase = 1;
});

/** A report as the reporter sends it: two workers, a leaky run's four findings or none. */
const report = (leaky: boolean) =>
  demoResourceReport({
    leaky,
    wallMs: 60_000,
    workers: [
      { worker: 0, tests: 3 },
      { worker: 1, tests: 2 },
    ],
    fixtureFile: 'tests/fixtures.ts',
    handleTest: { title: 'exports', file: 'tests/reports.spec.ts' },
    artifactBytes: 5_000_000,
    shardIndex: null,
  });

let nextRun = 100;
let nextCase = 1;
/** A finished run of project 1, a minute after the one before, with its report and the outcomes of its tests. */
async function run(opts: {
  leaky?: boolean;
  findings?: WireResourceFinding[];
  counts?: WireResourceReport['counts'];
  branch?: string | null;
  full?: boolean;
  baseBranch?: string;
  /** The tests that ran, by file and outcome. */
  cases?: Array<{ file: string; status: string }>;
}) {
  const id = nextRun++;
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(Date.UTC(2026, 0, 1) + id * 60_000),
    branch: opts.branch === undefined ? 'main' : opts.branch,
    isFullRun: opts.full === false ? 0 : 1,
    metadata: opts.baseBranch ? { scm: { branch: opts.branch, baseBranch: opts.baseBranch } } : null,
  });
  const part = report(opts.leaky ?? false);
  await saveResourceReportPart(db as any, id, {
    ...part,
    ...(opts.findings && { findings: opts.findings }),
    ...(opts.counts && { counts: opts.counts }),
  });
  for (const { file, status } of opts.cases ?? []) {
    const testCaseId = nextCase++;
    await db
      .insert(schema.testCases)
      .values({ id: testCaseId, projectId: 1, title: `test ${testCaseId}`, filePath: file });
    await db.insert(schema.testRunsCases).values({ testRunId: id, testCaseId, status });
  }
  return id;
}

const record = (id: number) => recordRunResourceFindings(db as any, id);

/** A context left open at a line of a spec file. */
const leakAt = (line: number, file = 'tests/cart.spec.ts'): WireResourceFinding => ({
  verdict: 'leaked',
  kind: 'context',
  where: `${file}:${line}`,
  site: `${file}:${line}`,
  scope: 'test',
  tests: 1,
  count: 1,
  heldMs: 1000,
});

/** The project's one finding, whatever its status. */
async function theFinding() {
  const findings = await listResourceFindings(db as any, 1, { status: 'all' });
  expect(findings).toHaveLength(1);
  return findings[0]!;
}

describe('finding history', () => {
  test('records each finding once per run, however often the run is finished', async () => {
    const first = await run({ leaky: true });
    await record(first);
    await record(first);
    const findings = await listResourceFindings(db as any, 1);
    expect(findings.map((f) => f.verdict).sort()).toEqual(['handle', 'idle', 'leaked', 'lingering', 'piling']);
    expect(findings.every((f) => f.runs === 1 && f.firstSeenRunId === first)).toBe(true);
    expect(await db.select().from(schema.resourceOccurrences)).toHaveLength(5);

    const second = await run({ leaky: true });
    await record(second);
    const leaked = (await listResourceFindings(db as any, 1, { verdict: 'leaked' }))[0]!;
    expect(leaked).toMatchObject({ runs: 2, firstSeenRunId: first, lastSeenRunId: second, status: 'open' });
  });

  test('fixes a finding after five clean full runs of the default branch, and reopens it when it comes back', async () => {
    await record(await run({ leaky: true }));
    // Neither a partial run nor a feature-branch run vouches for the fix.
    await record(await run({ full: false }));
    await record(await run({ branch: 'feature/x' }));
    const clean: number[] = [];
    for (let i = 0; i < FIXED_AFTER_CLEAN_RUNS; i++) {
      const id = await run({});
      clean.push(id);
      const recorded = await record(id);
      // A retried finish does not count the same run twice.
      await record(id);
      expect(recorded.fixed).toHaveLength(i === FIXED_AFTER_CLEAN_RUNS - 1 ? 5 : 0);
    }
    const leaked = (await listResourceFindings(db as any, 1, { status: 'all', verdict: 'leaked' }))[0]!;
    expect(leaked).toMatchObject({ status: 'fixed', fixedRunId: clean[0], cleanRuns: FIXED_AFTER_CLEAN_RUNS });
    expect(await listResourceFindings(db as any, 1)).toEqual([]);

    const back = await run({ leaky: true });
    expect((await record(back)).reopened).toHaveLength(5);
    expect((await listResourceFindings(db as any, 1, { verdict: 'leaked' }))[0]).toMatchObject({
      status: 'open',
      reopenedRunId: back,
      cleanRuns: 0,
      fixedRunId: null,
    });
  });

  test('only a full run of the default branch changes a finding’s status or clean runs; any other run records its showing', async () => {
    await record(await run({ findings: [leakAt(10)] }));
    await record(await run({ findings: [] }));
    await record(await run({ findings: [] }));
    // A branch forked before the fix, and a partial run, still show it.
    await record(await run({ branch: 'feature/old', findings: [leakAt(10)] }));
    await record(await run({ full: false, findings: [leakAt(10)] }));
    expect(await theFinding()).toMatchObject({ status: 'open', cleanRuns: 2, runs: 3 });

    for (let i = 2; i < FIXED_AFTER_CLEAN_RUNS; i++) await record(await run({ findings: [] }));
    expect(await theFinding()).toMatchObject({ status: 'fixed', cleanRuns: FIXED_AFTER_CLEAN_RUNS });

    const stale = await run({ branch: 'feature/old', findings: [leakAt(10)] });
    expect((await record(stale)).reopened).toEqual([]);
    expect((await record(await run({ full: false, findings: [leakAt(10)] }))).reopened).toEqual([]);
    expect(await theFinding()).toMatchObject({ status: 'fixed', runs: 5, reopenedRunId: null });

    const back = await run({ findings: [leakAt(10)] });
    expect((await record(back)).reopened).toHaveLength(1);
    expect(await theFinding()).toMatchObject({ status: 'open', reopenedRunId: back, cleanRuns: 0, runs: 6 });
  });

  test('a finding is new until a run of the base branch shows it, and a run with no branch counts as the default branch', async () => {
    const onBranch = await run({ leaky: true, branch: 'feature/login', baseBranch: 'main' });
    await record(onBranch);
    const again = await run({ leaky: true, branch: 'feature/login', baseBranch: 'main' });
    const novelty = (await runFindingsNovelty(db as any, again))!;
    expect(novelty.baseBranch).toBe('main');
    expect(novelty.findings.every((f) => f.isNew)).toBe(true);

    await record(await run({ leaky: true, branch: null }));
    const later = await run({ leaky: true, branch: 'feature/login', baseBranch: 'main' });
    expect((await runFindingsNovelty(db as any, later))!.findings.some((f) => f.isNew)).toBe(false);

    const resources = (await getRunResources(db as any, later))!;
    expect(resources.baseBranch).toBe('main');
    expect(Object.values(resources.history)).toHaveLength(5);
    expect(Object.values(resources.history).every((h) => !h.isNew && h.firstSeenRunId === onBranch)).toBe(true);
  });

  test('orders runs by when they started, not by when they were stored', async () => {
    // Stored first, started last: the newest run on main.
    await db.insert(schema.testRuns).values({
      id: 50,
      projectId: 1,
      status: 'passed',
      startTime: new Date(Date.UTC(2026, 6, 1)),
      branch: 'main',
    });
    await saveResourceReportPart(db as any, 50, report(true));
    const older = await run({ leaky: true });
    await record(older);
    expect((await runFindingsNovelty(db as any, 50))!.findings.every((f) => !f.isNew)).toBe(true);
    expect((await runFindingsNovelty(db as any, older))!.findings.every((f) => f.isNew)).toBe(true);
    await record(50);
    expect((await listResourceFindings(db as any, 1, { verdict: 'leaked' }))[0]).toMatchObject({
      firstSeenRunId: older,
      lastSeenRunId: 50,
    });
  });

  test('counts each opening line on its own, however many share a file', async () => {
    const id = await run({ findings: [leakAt(10), leakAt(40)] });
    expect((await runFindingsNovelty(db as any, id))!.findings.map((f) => f.finding.site)).toEqual([
      'tests/cart.spec.ts:10',
      'tests/cart.spec.ts:40',
    ]);
    await record(id);
    expect(await listResourceFindings(db as any, 1)).toHaveLength(2);
  });

  test('a leak an edit above its line moved keeps its history and is not new', async () => {
    const onMain = await run({ findings: [leakAt(10)] });
    await record(onMain);
    const pullRequest = await run({ branch: 'feature/cart', baseBranch: 'main', findings: [leakAt(12)] });
    expect((await runFindingsNovelty(db as any, pullRequest))!.findings[0]!.isNew).toBe(false);
    await record(pullRequest);
    // The pull request's showing joins the finding, which keeps the default branch's line.
    expect(await listResourceFindings(db as any, 1)).toEqual([
      expect.objectContaining({ where: 'tests/cart.spec.ts:10', firstSeenRunId: onMain, runs: 2 }),
    ]);
    // The pull request's run page reads the finding's history.
    expect(Object.values((await getRunResources(db as any, pullRequest))!.history)).toEqual([
      { isNew: false, firstSeenRunId: onMain, runs: 2, reopened: false },
    ]);
    // Merged: the default branch shows it at the new line.
    await record(await run({ findings: [leakAt(12)] }));
    expect(await listResourceFindings(db as any, 1)).toEqual([
      expect.objectContaining({ where: 'tests/cart.spec.ts:12', firstSeenRunId: onMain, runs: 3 }),
    ]);
  });

  test('a branch run never moves the default branch’s finding to its own lines', async () => {
    const onMain = await run({ findings: [leakAt(10)] });
    await record(onMain);
    const before = await theFinding();
    await record(await run({ branch: 'feature/cart', baseBranch: 'main', findings: [leakAt(12)] }));
    expect(await theFinding()).toMatchObject({
      fingerprint: before.fingerprint,
      where: 'tests/cart.spec.ts:10',
      site: 'tests/cart.spec.ts:10',
      lastSeenRunId: onMain,
    });
  });

  test('a new leak of another fixture in the same file is new, not a move', async () => {
    const fixtureLeak = (name: string, line: number): WireResourceFinding => ({
      ...leakAt(line, 'tests/fixtures.ts'),
      where: `fixture "${name}" at tests/fixtures.ts:${line}`,
    });
    await record(await run({ findings: [fixtureLeak('adminContext', 14)] }));
    const pullRequest = await run({
      branch: 'feature/users',
      baseBranch: 'main',
      findings: [fixtureLeak('userContext', 44)],
    });
    expect((await runLeakFacts(db as any, pullRequest)).newLeaks).toEqual([
      { where: 'fixture "userContext" at tests/fixtures.ts:44', site: 'tests/fixtures.ts:44', tests: 1 },
    ]);
  });

  test('a finding first shown on a branch reaches the default branch new, not back after its fix', async () => {
    await record(await run({ branch: 'feature/cart', baseBranch: 'main', findings: [leakAt(10)] }));
    for (let i = 0; i < FIXED_AFTER_CLEAN_RUNS; i++) await record(await run({ findings: [] }));
    expect(await theFinding()).toMatchObject({ status: 'fixed' });

    const merged = await run({ findings: [leakAt(10)] });
    expect((await record(merged)).reopened).toEqual([]);
    expect(await theFinding()).toMatchObject({ status: 'open', reopenedRunId: null, fixedRunId: null, cleanRuns: 0 });
  });

  test('two default-branch runs that finish out of order keep one finding', async () => {
    const first = await run({ findings: [leakAt(10)] });
    await record(first);
    // Started before the edit above the leak reached the default branch, finished after the run that has it.
    const earlier = await run({ findings: [leakAt(10)] });
    const later = await run({ findings: [leakAt(12)] });
    await record(later);
    await record(earlier);
    expect(await theFinding()).toMatchObject({
      where: 'tests/cart.spec.ts:12',
      firstSeenRunId: first,
      lastSeenRunId: later,
      runs: 3,
    });
    expect(Object.values((await getRunResources(db as any, earlier))!.history)).toEqual([
      { isNew: false, firstSeenRunId: first, runs: 3, reopened: false },
    ]);
  });

  test('two runs that show the same new leak at the same time both keep their showing', async () => {
    const a = await run({ findings: [leakAt(10)] });
    const b = await run({ findings: [leakAt(10)] });
    await Promise.all([record(a), record(b)]);
    expect(await theFinding()).toMatchObject({ runs: 2, firstSeenRunId: a, lastSeenRunId: b });
    expect((await db.select().from(schema.resourceOccurrences)).map((o) => o.runId).sort()).toEqual([a, b]);
  });

  test('a run vouches for a finding only when its report could show it', async () => {
    const atFixture: WireResourceFinding = {
      ...leakAt(14, 'tests/fixtures.ts'),
      where: 'fixture "loggedInContext" at tests/fixtures.ts:14',
    };
    await record(await run({ findings: [leakAt(10), atFixture] }));
    const cleanRuns = async () =>
      Object.fromEntries(
        (await db.select().from(schema.resourceFindings))
          .filter((f) => !f.place.startsWith('tests/other.spec.ts'))
          .map((f) => [f.site, f.cleanRuns]),
      );

    // A test of the leak's file failed: what it left open was never judged.
    await record(await run({ findings: [], cases: [{ file: 'tests/cart.spec.ts', status: 'failed' }] }));
    // The report holds the most findings the dashboard keeps, and counts leaks past them.
    const elsewhere = Array.from({ length: 100 }, (_, i) => ({
      verdict: 'idle' as const,
      kind: 'page' as const,
      where: `tests/other.spec.ts:${i + 1}`,
      site: `tests/other.spec.ts:${i + 1}`,
      tests: 1,
      count: 1,
    }));
    await record(
      await run({
        findings: elsewhere,
        counts: { leaked: 2, lingering: 0, idle: 100, piling: 0, handle: 0, probable: 0 },
      }),
    );
    expect(await cleanRuns()).toEqual({ 'tests/cart.spec.ts:10': 0, 'tests/fixtures.ts:14': 0 });

    // A failure in another spec file hides no leak of this one, but may hide a fixture's.
    await record(
      await run({
        findings: [],
        cases: [
          { file: 'tests/cart.spec.ts', status: 'passed' },
          { file: 'tests/other.spec.ts', status: 'timedout' },
        ],
      }),
    );
    expect(await cleanRuns()).toEqual({ 'tests/cart.spec.ts:10': 1, 'tests/fixtures.ts:14': 0 });

    // A test that failed, then passed on a retry, showed what it left open.
    const retried = await run({ findings: [] });
    await db
      .insert(schema.testCases)
      .values({ id: 900, projectId: 1, title: 'retried', filePath: 'tests/cart.spec.ts' });
    await db.insert(schema.testRunsCases).values([
      { testRunId: retried, testCaseId: 900, status: 'failed', retries: 0 },
      { testRunId: retried, testCaseId: 900, status: 'passed', retries: 1 },
    ]);
    await record(retried);
    expect(await cleanRuns()).toEqual({ 'tests/cart.spec.ts:10': 2, 'tests/fixtures.ts:14': 1 });

    // Tests that did not run, after too many failures, or in a run interrupted, left nothing to judge.
    await record(
      await run({
        findings: [],
        cases: [
          { file: 'tests/cart.spec.ts', status: 'didnotrun' },
          { file: 'tests/other.spec.ts', status: 'failed' },
        ],
      }),
    );
    await record(
      await run({
        findings: [],
        cases: [
          { file: 'tests/cart.spec.ts', status: 'passed' },
          { file: 'tests/other.spec.ts', status: 'interrupted' },
        ],
      }),
    );
    expect(await cleanRuns()).toEqual({ 'tests/cart.spec.ts:10': 3, 'tests/fixtures.ts:14': 1 });
    // Nor did a file whose tests were all skipped.
    await record(
      await run({
        findings: [],
        cases: [
          { file: 'tests/cart.spec.ts', status: 'skipped' },
          { file: 'tests/other.spec.ts', status: 'failed' },
        ],
      }),
    );
    expect(await cleanRuns()).toEqual({ 'tests/cart.spec.ts:10': 3, 'tests/fixtures.ts:14': 1 });
  });

  test('pairs a moved finding with the closest line of its group, each candidate once', () => {
    const shown = (line: number) => ({ fingerprint: resourceFingerprint(leakAt(line)), finding: leakAt(line) });
    const stored = (line: number) => ({ fingerprint: resourceFingerprint(leakAt(line)), place: leakAt(line).where });
    const [at12, at52, at90] = [shown(12), shown(52), shown(90)];
    const [from10, from50] = [stored(10), stored(50)];
    const pairs = pairMoved([at52, at12, at90], [from50, from10]);
    expect(pairs.get(at12)).toBe(from10);
    expect(pairs.get(at52)).toBe(from50);
    expect(pairs.has(at90)).toBe(false);
  });

  test('says nothing about a run that sent no report', async () => {
    await db.insert(schema.testRuns).values({ id: 99, projectId: 1, status: 'passed', startTime: new Date() });
    expect(await runFindingsNovelty(db as any, 99)).toBeNull();
    expect(await record(99)).toEqual({ seen: 0, fixed: [], reopened: [] });
  });
});

describe('the leaks a change closes', () => {
  /** What the pull request's run closed of the default branch's open leaks. */
  async function closedBy(id: number) {
    const novelty = (await runFindingsNovelty(db as any, id))!;
    return (await runClosedFindings(db as any, id, novelty)).map((f) => f.site);
  }
  const passed = [
    { file: 'tests/cart.spec.ts', status: 'passed' },
    { file: 'tests/reports.spec.ts', status: 'passed' },
  ];
  const change = (more: Parameters<typeof run>[0] = {}) =>
    run({ branch: 'feature/fix', baseBranch: 'main', findings: [], cases: passed, ...more });
  const serverAt = (line: number): WireResourceFinding => ({
    verdict: 'handle',
    kind: 'handle',
    where: 'TCPServerWrap',
    site: `tests/reports.spec.ts:${line}`,
    detail: '"exports" (tests/reports.spec.ts)',
    tests: 1,
    count: 1,
  });

  test('an open leak or server of the default branch that a full run of the change could show and did not', async () => {
    await record(await run({ findings: [leakAt(10), serverAt(30)] }));
    expect(await closedBy(await change())).toEqual(['tests/cart.spec.ts:10', 'tests/reports.spec.ts:30']);
    // A run of the default branch closes nothing for a change.
    expect(await closedBy(await run({ findings: [], cases: passed }))).toEqual([]);
  });

  test('never one the change still shows, at its own line or moved by an edit above it', async () => {
    await record(await run({ findings: [leakAt(10)] }));
    expect(await closedBy(await change({ findings: [leakAt(10)] }))).toEqual([]);
    expect(await closedBy(await change({ findings: [leakAt(14)] }))).toEqual([]);
  });

  test('only one whose spec file had a test that passed in the run and none that failed', async () => {
    await record(await run({ findings: [leakAt(10), leakAt(40, 'tests/admin.spec.ts')] }));
    expect(await closedBy(await change())).toEqual(['tests/cart.spec.ts:10']);
    expect(await closedBy(await change({ cases: [{ file: 'tests/cart.spec.ts', status: 'skipped' }] }))).toEqual([]);
    expect(
      await closedBy(
        await change({
          cases: [
            { file: 'tests/cart.spec.ts', status: 'passed' },
            { file: 'tests/cart.spec.ts', status: 'failed' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("never a fixture's leak, whose file holds no test", async () => {
    await record(await run({ findings: [leakAt(14, 'tests/fixtures.ts')] }));
    expect(await closedBy(await change())).toEqual([]);
  });

  test('never from a partial run, nor for a leak only a partial run of the default branch showed', async () => {
    await record(await run({ findings: [leakAt(10)] }));
    expect(await closedBy(await change({ full: false }))).toEqual([]);
    await record(await run({ findings: [leakAt(20, 'tests/reports.spec.ts')], full: false }));
    expect(await closedBy(await change())).toEqual(['tests/cart.spec.ts:10']);
  });

  test('never one the default branch no longer shows itself', async () => {
    await record(await run({ findings: [leakAt(10)] }));
    await record(await run({ findings: [], cases: passed }));
    expect(await closedBy(await change())).toEqual([]);
  });

  test('only for a run of a pull request into the default branch', async () => {
    await record(await run({ findings: [leakAt(10)] }));
    expect(await closedBy(await change({ baseBranch: 'release/1' }))).toEqual([]);
    // A push build of the branch names no target.
    expect(await closedBy(await run({ branch: 'feature/fix', findings: [], cases: passed }))).toEqual([]);
  });
});

describe('the leaks the gate reads', () => {
  test('a run’s leaks, and those its base branch never showed', async () => {
    await record(await run({ findings: [leakAt(10)] }));
    const id = await run({ branch: 'feature/cart', baseBranch: 'main', findings: [leakAt(10), leakAt(40)] });
    expect(await runLeakFacts(db as any, id)).toEqual({
      reported: true,
      leaks: [
        { where: 'tests/cart.spec.ts:10', site: 'tests/cart.spec.ts:10', tests: 1 },
        { where: 'tests/cart.spec.ts:40', site: 'tests/cart.spec.ts:40', tests: 1 },
      ],
      newLeaks: [{ where: 'tests/cart.spec.ts:40', site: 'tests/cart.spec.ts:40', tests: 1 }],
      baseBranch: 'main',
    });
  });

  test('are not measured for a project that declined the capability, which keeps no history of them', async () => {
    await db
      .update(schema.projects)
      .set({ capabilities: { resources: 'declined' } })
      .where(eq(schema.projects.id, 1));
    await record(await run({ findings: [leakAt(10)] }));
    const id = await run({ findings: [leakAt(10)] });
    await record(id);
    const resources = await runLeakFacts(db as any, id);
    expect(resources).toEqual({ reported: false, declined: true, leaks: [], newLeaks: [], baseBranch: null });
  });

  test('are not measured for a run that sent no report', async () => {
    await db.insert(schema.testRuns).values({ id: 99, projectId: 1, status: 'passed', startTime: new Date() });
    expect(await runLeakFacts(db as any, 99)).toEqual({ reported: false, leaks: [], newLeaks: [], baseBranch: null });
  });
});

describe('a finding’s identity', () => {
  const fingerprint = (finding: Partial<WireResourceFinding>) =>
    resourceFingerprint({ tests: 1, count: 1, ...finding } as WireResourceFinding);

  test('a probable leak keeps it when a closed opening joins its file', () => {
    const probable = { verdict: 'probable', kind: 'context', tests: 0 } as const;
    expect(
      fingerprint({ ...probable, where: 'tests/a.spec.ts:3', detail: '1 opened, 0 closed in tests/a.spec.ts' }),
    ).toBe(
      fingerprint({
        ...probable,
        where: 'tests/a.spec.ts:3, tests/a.spec.ts:9',
        detail: '2 opened, 1 closed in tests/a.spec.ts',
      }),
    );
    // A test of the file opens and closes one through a helper.
    expect(
      fingerprint({
        ...probable,
        where: 'tests/a.spec.ts:3, tests/helpers.ts:7',
        detail: '2 opened, 1 closed in tests/a.spec.ts',
      }),
    ).toBe(fingerprint({ ...probable, where: 'tests/a.spec.ts:3', detail: '1 opened, 0 closed in tests/a.spec.ts' }));
    expect(fingerprint({ ...probable, where: 'tests/a.spec.ts:3' })).not.toBe(
      fingerprint({ ...probable, where: 'tests/b.spec.ts:3' }),
    );
  });

  test('a probable leak with its line is known by that line, as a leak is', () => {
    const probable = { verdict: 'probable', kind: 'context', tests: 1 } as const;
    const at = (line: number, detail = 'left open by its test') =>
      fingerprint({ ...probable, where: `tests/a.spec.ts:${line}`, site: `tests/a.spec.ts:${line}`, detail });
    expect(at(3)).not.toBe(at(9));
    expect(at(3)).toBe(at(3, '2 contexts left open by 2 tests'));
    expect(at(3)).not.toBe(
      fingerprint({ ...probable, where: 'tests/a.spec.ts:3', detail: '1 opened, 0 closed in tests/a.spec.ts' }),
    );
  });

  test('a page never used keeps it whatever fixtures its tests set up', () => {
    const idle = { verdict: 'idle', kind: 'page', where: 'fixture "page"' } as const;
    expect(fingerprint({ ...idle, detail: 'set up with loggedInPage (tests/fixtures.ts:20)' })).toBe(
      fingerprint({ ...idle, detail: 'set up with loggedInPage (tests/fixtures.ts:22), cart (tests/fixtures.ts:40)' }),
    );
  });

  test('a handle is known by the line that started it, else by its test’s file, never by the test’s title', () => {
    const server = { verdict: 'handle', kind: 'handle', where: 'TCPServerWrap' } as const;
    const at5 = fingerprint({ ...server, site: 'tests/a.spec.ts:5', detail: '"exports" (tests/a.spec.ts)' });
    expect(fingerprint({ ...server, site: 'tests/a.spec.ts:5', detail: '"exports as CSV" (tests/a.spec.ts)' })).toBe(
      at5,
    );
    expect(fingerprint({ ...server, site: 'tests/a.spec.ts:9', detail: '"exports" (tests/a.spec.ts)' })).not.toBe(at5);
    expect(fingerprint({ ...server, site: 'tests/a.spec.ts:5', where: 'ChildProcess' })).not.toBe(at5);

    const unplaced = fingerprint({ ...server, detail: '"exports" (tests/a.spec.ts)' });
    expect(fingerprint({ ...server, detail: '"exports (CSV)" (tests/a.spec.ts)' })).toBe(unplaced);
    expect(fingerprint({ ...server, detail: '"exports" (tests/b.spec.ts)' })).not.toBe(unplaced);
    expect(fingerprint({ ...server, detail: '"exports" (tests/(admin)/a.spec.ts)' })).not.toBe(
      fingerprint({ ...server, detail: '"exports" (tests/(shop)/a.spec.ts)' }),
    );
  });

  test('names the source file of its place, whatever the path holds', () => {
    expect(identityFile(fingerprint(leakAt(10, 'tests/(admin)/my cart.spec.ts')))).toBe(
      'tests/(admin)/my cart.spec.ts',
    );
    const server = { verdict: 'handle', kind: 'handle', where: 'TCPServerWrap' } as const;
    expect(identityFile(fingerprint({ ...server, site: 'tests/a.spec.ts:5' }))).toBe('tests/a.spec.ts');
    expect(identityFile(fingerprint({ ...server, detail: '"exports" (tests/(admin)/a.spec.ts)' }))).toBe(
      'tests/(admin)/a.spec.ts',
    );
    expect(identityFile(fingerprint({ verdict: 'idle', kind: 'page', where: 'fixture "page"' }))).toBeNull();
    expect(identityFile(fingerprint({ verdict: 'piling', kind: 'worker', where: 'worker process' }))).toBeNull();
  });

  test('a fixture’s leak is known by its line, not by the fixture’s name', () => {
    const leak = { verdict: 'leaked', kind: 'context', scope: 'test', site: 'tests/fixtures.ts:14' } as const;
    expect(fingerprint({ ...leak, where: 'fixture "loggedInContext" at tests/fixtures.ts:14' })).toBe(
      fingerprint({ ...leak, where: 'fixture "authedContext" at tests/fixtures.ts:14' }),
    );
    expect(fingerprint({ ...leak, where: 'fixture "page"', site: null })).not.toBe(
      fingerprint({ ...leak, where: 'fixture "context"', site: null }),
    );
  });

  test('the findings stored under the first identity take the current one once, those it joins merged', async () => {
    const legacy = (finding: Partial<WireResourceFinding>) =>
      [
        finding.verdict,
        finding.kind,
        finding.scope ?? '',
        finding.where ?? '',
        finding.growth?.what ?? '',
        finding.verdict === 'handle' || finding.verdict === 'idle' ? (finding.detail ?? '') : '',
      ].join('|');
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1) + minute * 60_000);
    const runs = [100, 101, 102, 103];
    for (const id of runs) {
      await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'passed', startTime: at(id) });
    }
    const findings: Array<Partial<WireResourceFinding>> = [
      {
        verdict: 'leaked',
        kind: 'context',
        scope: 'test',
        where: 'fixture "loggedInContext" at tests/fixtures.ts:14',
        site: 'tests/fixtures.ts:14',
      },
      {
        verdict: 'idle',
        kind: 'page',
        where: 'fixture "page"',
        detail: 'set up with loggedInPage (tests/fixtures.ts:20)',
      },
      { verdict: 'idle', kind: 'page', where: 'fixture "page"', detail: 'set up with cart (tests/fixtures.ts:40)' },
      { verdict: 'handle', kind: 'handle', where: 'TCPServerWrap', detail: '"exports" (tests/reports.spec.ts)' },
      {
        verdict: 'piling',
        kind: 'page',
        where: 'fixture "sharedPage" at tests/fixtures.ts:31',
        site: 'tests/fixtures.ts:31',
        growth: { what: 'listeners', from: 2, to: 8, tests: 3 },
      },
      { verdict: 'probable', kind: 'browser', where: 'tests/a.spec.ts:3, tests/a.spec.ts:9' },
    ];
    // Each shown in its own runs; the two pages never used, in runs 101 (both) and 102 and 103 (one each).
    const shownIn = [[100], [101, 103], [101, 102], [100, 101], [102], [103]];
    for (const [i, finding] of findings.entries()) {
      const [firstRun, lastRun] = [shownIn[i]![0]!, shownIn[i]!.at(-1)!];
      await db.insert(schema.resourceFindings).values({
        id: i + 1,
        projectId: 1,
        fingerprint: legacy(finding),
        verdict: finding.verdict!,
        kind: finding.kind!,
        place: finding.where!,
        site: finding.site ?? null,
        firstSeenRunId: firstRun,
        lastSeenRunId: lastRun,
        firstSeenAt: at(firstRun),
        lastSeenAt: at(lastRun),
        occurrences: shownIn[i]!.length,
        ...(i === 2 && { status: 'fixed', cleanRuns: 5, fixedRunId: 102 }),
        ...(i === 1 && { cleanRuns: 0 }),
      });
      for (const runId of shownIn[i]!) {
        await db.insert(schema.resourceOccurrences).values({ findingId: i + 1, runId, count: 2, tests: 1 });
      }
    }

    expect(await rekeyResourceFindingsOnce(db as any)).toEqual({ updated: 5, merged: 1 });
    expect(await rekeyResourceFindingsOnce(db as any)).toBeNull();

    const rows = await db.select().from(schema.resourceFindings);
    const current = (finding: Partial<WireResourceFinding>) =>
      resourceFingerprint({ tests: 1, count: 1, ...finding } as WireResourceFinding);
    expect(rows.map((row) => row.fingerprint).sort()).toEqual(
      [...new Set(findings.map((finding) => current(finding)))].sort(),
    );
    // The two pages never used are one finding, shown in three runs since the first's, open as its latest showing.
    const idle = rows.find((row) => row.verdict === 'idle')!;
    expect(idle).toMatchObject({
      id: 2,
      occurrences: 3,
      firstSeenRunId: 101,
      lastSeenRunId: 103,
      status: 'open',
      cleanRuns: 0,
    });
    const occurrences = await db
      .select()
      .from(schema.resourceOccurrences)
      .where(eq(schema.resourceOccurrences.findingId, idle.id));
    expect(occurrences.map((o) => [o.runId, o.count]).sort()).toEqual([
      [101, 4],
      [102, 2],
      [103, 2],
    ]);
  });
});
