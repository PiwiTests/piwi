import { describe, test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { sanitizeExecutionResources, sanitizeResourceReport } from '../../shared/resource-report';
import { demoExecutionResources, demoResourceReport } from '../../shared/demo/demo-resources.mjs';
import { resourceFingerprint } from '../../shared/resource-fingerprint.mjs';
import type { WireResourceFinding } from '../../shared/types';
import { findingView } from '../../shared/resource-copy';
import { machineFacts, resourceTotals } from '../../app/utils/resources';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getRunResources, getRunResourceTimeline } = await import('../../shared/handlers/run-resources');
const { saveResourceReportPart, readResourceReport, hasResourceReport } =
  await import('../../shared/handlers/resource-reports');
const { getTestRun } = await import('../../shared/handlers/test-runs');
const { getCapabilityEvidence } = await import('../../shared/handlers/setup-status');
const { recordRunResourceFindings, runFindingsNovelty, listResourceFindings, pairMoved, FIXED_AFTER_CLEAN_RUNS } =
  await import('../../shared/handlers/resource-findings');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
});

const report = (shardIndex: number | null, leaky = true) =>
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
    shardIndex,
  });

/** A report with a timeline: two workers, each test a page, the leaky ones left open. */
const timedReport = (shardIndex: number | null, leaky = true) =>
  demoResourceReport({
    leaky,
    wallMs: 60_000,
    workers: [
      {
        worker: 0,
        tests: 2,
        spans: [
          [1_000_000, 1_020_000],
          [1_021_000, 1_040_000],
        ],
      },
      { worker: 1, tests: 1, spans: [[1_000_500, 1_050_000]] },
    ],
    fixtureFile: 'tests/fixtures.ts',
    handleTest: { title: 'exports', file: 'tests/reports.spec.ts' },
    artifactBytes: 5_000_000,
    shardIndex,
  });

describe('sanitizeResourceReport', () => {
  test('keeps a report as the reporter sends it', () => {
    const sent = report(null);
    expect(sanitizeResourceReport(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
    const timed = timedReport(null);
    expect(timed.timeline).not.toBeNull();
    expect(sanitizeResourceReport(JSON.parse(JSON.stringify(timed)))).toEqual(timed);
  });

  test('rebuilds the timeline from finite points, bounded', () => {
    const clean = sanitizeResourceReport({
      ...timedReport(null),
      timeline: {
        startedAt: 1_000_000.4,
        cpuPct: [[1000, 140], [2000, -1], ['x', 3], [3000.6, 50], 7],
        memoryBytes: Array.from({ length: 900 }, (_, i) => [i * 5000, 1e9]),
        pages: [
          {
            worker: 0,
            points: [
              [0, 1.6],
              [10, 'x'],
            ],
          },
          { worker: 1, points: [] },
          { worker: 'a', points: [[0, 1]] },
        ],
        workers: [
          {
            worker: 0,
            cpuCores: [
              [1000, 2.5],
              [2000, 5000],
            ],
            memoryBytes: [[1000, -4]],
          },
          { worker: 1, cpuCores: [], memoryBytes: [] },
          { worker: null, cpuCores: [[1000, 1]] },
        ],
        extra: true,
      },
    })!;
    expect(clean.timeline).toEqual({
      startedAt: 1_000_000,
      cpuPct: [
        [1000, 100],
        [3001, 50],
      ],
      memoryBytes: Array.from({ length: 600 }, (_, i) => [i * 5000, 1e9]),
      pages: [{ worker: 0, points: [[0, 2]] }],
      workers: [
        {
          worker: 0,
          cpuCores: [
            [1000, 2.5],
            [2000, 1024],
          ],
          memoryBytes: [],
        },
      ],
    });
    expect(
      sanitizeResourceReport({ ...timedReport(null), timeline: { startedAt: 'now', cpuPct: [[1, 2]] } })!.timeline,
    ).toBeNull();
  });

  test('rejects what is not a report, and drops what does not belong in one', () => {
    expect(sanitizeResourceReport(null)).toBeNull();
    expect(sanitizeResourceReport({ v: 2 })).toBeNull();
    const clean = sanitizeResourceReport({
      v: 1,
      findings: [
        { verdict: 'leaked', kind: 'page', where: 'tests/a.spec.ts:3', tests: 1, count: 1, extra: 'x' },
        { verdict: 'exploded', kind: 'page', where: 'x', tests: 1, count: 1 },
        { verdict: 'idle', kind: 'page', where: '', tests: 1, count: 1 },
        ...Array.from({ length: 200 }, (_, i) => ({
          verdict: 'idle',
          kind: 'page',
          where: `w${i}`,
          tests: 1,
          count: 1,
        })),
      ],
      counts: { leaked: -3, idle: 'many' },
      profile: { platform: 'linux' },
      workers: [
        { worker: 0, openPages: [1, -2, 'x', 3.6] },
        { worker: 'a', openPages: [] },
      ],
      artifactBytes: { trace: 10, movie: 99 },
    })!;
    expect(clean.findings[0]).toEqual({
      verdict: 'leaked',
      kind: 'page',
      where: 'tests/a.spec.ts:3',
      tests: 1,
      count: 1,
    });
    // The first 100 entries are read; the two invalid ones among them are dropped.
    expect(clean.findings).toHaveLength(98);
    expect(clean.counts).toEqual({ leaked: 0, idle: 0, piling: 0, handle: 0, probable: 0 });
    expect(clean.profile).toBeNull();
    expect(clean.workers).toEqual([{ worker: 0, openPages: [1, 0, 0, 4] }]);
    expect(clean.artifactBytes).toEqual({ trace: 10 });
  });
});

describe('sanitizeExecutionResources', () => {
  test('keeps a cost as a worker measures it, and rejects one without the worker CPU', () => {
    const sent = demoExecutionResources({ seq: 3, durationMs: 4000, openAtStart: 2, leaky: true });
    expect(sanitizeExecutionResources(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
    expect(sanitizeExecutionResources({ loopUtilization: 0.2 })).toBeNull();
    expect(
      sanitizeExecutionResources({ workerCpuMs: 10, loopUtilization: 7, roles: { kernel: { cpuMs: 1 } } }),
    ).toMatchObject({ workerCpuMs: 10, loopUtilization: 1, roles: null });
  });
});

describe('the stored report', () => {
  beforeEach(async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.testRuns).values({ id: 7, projectId: 1, status: 'running', startTime: new Date() });
  });

  test('keeps one part per shard, in shard order, a retried finish replacing its own', async () => {
    expect(await hasResourceReport(db as any, 7)).toBe(false);
    await saveResourceReportPart(db as any, 7, report(2));
    await saveResourceReportPart(db as any, 7, report(1));
    await saveResourceReportPart(db as any, 7, report(2, false));
    expect((await readResourceReport(db as any, 7)).parts.map((p) => [p.shardIndex, p.counts.leaked])).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expect(await hasResourceReport(db as any, 7)).toBe(true);
  });

  test('keeps every shard when several finish at the same time', async () => {
    await Promise.all([1, 2, 3, 4].map((shard) => saveResourceReportPart(db as any, 7, report(shard))));
    expect((await readResourceReport(db as any, 7)).parts.map((p) => p.shardIndex)).toEqual([1, 2, 3, 4]);
  });
});

describe('getRunResources', () => {
  async function seedRun(capabilities: Record<string, string> | null = null) {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout', capabilities });
    await db.insert(schema.testRuns).values({
      id: 7,
      projectId: 1,
      status: 'passed',
      startTime: new Date(),
    });
    await saveResourceReportPart(db as any, 7, report(null));
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, title: 'cheap', filePath: 'tests/a.spec.ts' },
      { id: 2, projectId: 1, title: 'costly', filePath: 'tests/a.spec.ts' },
      { id: 3, projectId: 1, title: 'unmeasured', filePath: 'tests/a.spec.ts' },
    ]);
    await db.insert(schema.testRunsCases).values([
      {
        id: 11,
        testRunId: 7,
        testCaseId: 1,
        status: 'passed',
        line: 3,
        resources: demoExecutionResources({ seq: 1, durationMs: 1000 }),
      },
      {
        id: 12,
        testRunId: 7,
        testCaseId: 2,
        status: 'passed',
        line: 9,
        resources: demoExecutionResources({ seq: 2, durationMs: 9000, openAtStart: 3, leaky: true }),
      },
      { id: 13, testRunId: 7, testCaseId: 3, status: 'passed', line: 12 },
    ]);
  }

  test('serves the report and the measured executions, costliest first', async () => {
    await seedRun();
    const resources = (await getRunResources(db as any, 7))!;
    expect(resources.report!.parts).toHaveLength(1);
    expect(resources.measuredExecutions).toBe(2);
    expect(resources.costliest.map((e) => e.title)).toEqual(['costly', 'cheap']);
    expect(resources.costliest[0]).toMatchObject({ executionId: 12, openAtStartPages: 3, leftOpen: 1, line: 9 });
    expect(resources.costliest[0]!.cpuMs).toBeGreaterThan(resources.costliest[0]!.browserCpuMs!);

    const run = await getTestRun(db as any, 7);
    expect(run).toMatchObject({ hasResources: true });
    expect((await getCapabilityEvidence(db as any, 1)).resources).toBe(true);
  });

  test('serves nothing for a project that declined the capability, and null for a missing run', async () => {
    await seedRun({ resources: 'declined' });
    expect(await getRunResources(db as any, 7)).toEqual({
      report: null,
      baseBranch: null,
      history: {},
      costliest: [],
      measuredExecutions: 0,
    });
    expect(await getTestRun(db as any, 7)).toMatchObject({ hasResources: false });
    expect(await getRunResources(db as any, 99)).toBeNull();
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 1));
    expect(project?.capabilities).toEqual({ resources: 'declined' });
  });
});

describe('getRunResourceTimeline', () => {
  test('serves each shard’s timeline with the memory it is drawn against', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.testRuns).values({ id: 7, projectId: 1, status: 'passed', startTime: new Date() });
    await saveResourceReportPart(db as any, 7, timedReport(1));
    await saveResourceReportPart(db as any, 7, report(2));
    const { parts } = (await getRunResourceTimeline(db as any, 7))!;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ shardIndex: 1, memoryKind: 'pss', memoryCapacityBytes: 16 * 1024 ** 3 });
    // The shared page from the first test on, each leaky test's page left open, all gone with the worker.
    expect(parts[0]!.timeline.pages[0]!.points.map(([, n]) => n)).toEqual([1, 2, 3, 0]);
    expect(Math.max(...parts[0]!.timeline.memoryBytes.map(([, bytes]) => bytes))).toBe(
      Math.round(timedReport(1).profile!.memory.peakBytes!),
    );
    expect(await getRunResourceTimeline(db as any, 99)).toBeNull();
  });

  test('serves what each measured execution cost, its worker and browsers together', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.testRuns).values({ id: 7, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, title: 'adds', filePath: 'tests/a.spec.ts' });
    const leaky = demoExecutionResources({ seq: 2, durationMs: 9000, openAtStart: 3, leaky: true });
    await db.insert(schema.testRunsCases).values([
      { id: 11, testRunId: 7, testCaseId: 1, status: 'passed', resources: leaky },
      { id: 12, testRunId: 7, testCaseId: 1, status: 'passed' },
    ]);
    const { executions } = (await getRunResourceTimeline(db as any, 7))!;
    const roles = Object.values(leaky.roles!);
    expect(executions).toEqual([
      {
        executionId: 11,
        cpuMs: leaky.workerCpuMs + roles.reduce((sum, cost) => sum + cost!.cpuMs, 0),
        runWaitMs: roles.reduce((sum, cost) => sum + (cost!.runWaitMs ?? 0), 0),
        peakRssMb: Math.max(...roles.map((cost) => cost!.peakRssMb!)),
      },
    ]);
  });

  test('serves nothing for a project that declined the capability', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'checkout', capabilities: { resources: 'declined' } });
    await db.insert(schema.testRuns).values({ id: 7, projectId: 1, status: 'passed', startTime: new Date() });
    await saveResourceReportPart(db as any, 7, timedReport(null));
    expect(await getRunResourceTimeline(db as any, 7)).toEqual({ parts: [], executions: [] });
  });
});

describe('findingView', () => {
  test('reads each verdict in the words of the end-of-run summary', () => {
    const [leaked, idle, piling, handle] = report(null).findings.map(findingView);
    expect(leaked).toEqual({
      label: 'Leaked context',
      where: 'fixture "loggedInContext" at tests/fixtures.ts:14',
      site: 'tests/fixtures.ts:14',
      facts: [
        '5 contexts',
        'with 5 pages',
        '5 tests',
        'open until the worker shut down (49.2 s past its test)',
        '12.6 s of page CPU after its test',
      ],
    });
    expect(idle).toMatchObject({ label: 'Never used page', facts: ['3 pages', '3 tests', 'set up with loggedInPage'] });
    expect(piling).toMatchObject({ label: 'Piling up listeners', facts: ['2 → 8 over 3 tests'] });
    expect(handle).toEqual({
      label: 'Left running server',
      where: null,
      site: null,
      facts: ['left running in the worker by "exports" (tests/reports.spec.ts)'],
    });
  });
});

describe('machineFacts and resourceTotals', () => {
  test('describe the machine one resource per line, and sum the shards', () => {
    const facts = machineFacts(report(null));
    expect(facts.map((f) => f.label)).toEqual(['CPU', 'Memory', 'Disk', 'Workers']);
    expect(facts[0]!.facts[0]).toBe('88% busy');
    expect(facts[1]!.facts).toContain('largest process: renderer 620 MB');

    const totals = resourceTotals({ v: 1, parts: [report(1), report(2, false)] });
    expect(totals.counts).toEqual({ leaked: 1, idle: 3, piling: 1, handle: 1, probable: 0 });
    expect(totals.peakMemoryBytes).toBe(9.6 * 1024 ** 3);
    expect(totals.artifactBytes).toBe(10_000_000);
  });
});

describe('finding history', () => {
  let nextRun = 100;
  /** A finished run of project 1 whose report is the leaky one (or a clean one), on a branch. */
  async function run(opts: {
    leaky: boolean;
    branch?: string | null;
    full?: boolean;
    baseBranch?: string;
    findings?: WireResourceFinding[];
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
    const part = report(null, opts.leaky);
    await saveResourceReportPart(db as any, id, opts.findings ? { ...part, findings: opts.findings } : part);
    return id;
  }

  beforeEach(async () => {
    nextRun = 100;
    await db.insert(schema.projects).values({ id: 1, name: 'checkout', defaultBranch: 'main' });
  });

  test('records each finding once per run, however often the run is finished', async () => {
    const first = await run({ leaky: true });
    await recordRunResourceFindings(db as any, first);
    await recordRunResourceFindings(db as any, first);
    const findings = await listResourceFindings(db as any, 1);
    expect(findings.map((f) => f.verdict).sort()).toEqual(['handle', 'idle', 'leaked', 'piling']);
    expect(findings.every((f) => f.runs === 1 && f.firstSeenRunId === first)).toBe(true);
    expect(await db.select().from(schema.resourceOccurrences)).toHaveLength(4);

    const second = await run({ leaky: true });
    await recordRunResourceFindings(db as any, second);
    const leaked = (await listResourceFindings(db as any, 1, { verdict: 'leaked' }))[0]!;
    expect(leaked).toMatchObject({ runs: 2, firstSeenRunId: first, lastSeenRunId: second, status: 'open' });
  });

  test('fixes a finding after five clean full runs of the default branch, and reopens it when it comes back', async () => {
    await recordRunResourceFindings(db as any, await run({ leaky: true }));
    // Neither a partial run nor a feature-branch run vouches for the fix.
    await recordRunResourceFindings(db as any, await run({ leaky: false, full: false }));
    await recordRunResourceFindings(db as any, await run({ leaky: false, branch: 'feature/x' }));
    const clean: number[] = [];
    for (let i = 0; i < FIXED_AFTER_CLEAN_RUNS; i++) {
      const id = await run({ leaky: false });
      clean.push(id);
      const recorded = await recordRunResourceFindings(db as any, id);
      // A retried finish does not count the same run twice.
      await recordRunResourceFindings(db as any, id);
      expect(recorded.fixed).toHaveLength(i === FIXED_AFTER_CLEAN_RUNS - 1 ? 4 : 0);
    }
    const leaked = (await listResourceFindings(db as any, 1, { status: 'all', verdict: 'leaked' }))[0]!;
    expect(leaked).toMatchObject({ status: 'fixed', fixedRunId: clean[0], cleanRuns: FIXED_AFTER_CLEAN_RUNS });
    expect(await listResourceFindings(db as any, 1)).toEqual([]);

    const back = await run({ leaky: true });
    expect((await recordRunResourceFindings(db as any, back)).reopened).toHaveLength(4);
    expect((await listResourceFindings(db as any, 1, { verdict: 'leaked' }))[0]).toMatchObject({
      status: 'open',
      reopenedRunId: back,
      cleanRuns: 0,
      fixedRunId: null,
    });
  });

  test('a finding is new until a run of the base branch shows it, and a run with no branch counts as the default branch', async () => {
    const onBranch = await run({ leaky: true, branch: 'feature/login', baseBranch: 'main' });
    await recordRunResourceFindings(db as any, onBranch);
    const again = await run({ leaky: true, branch: 'feature/login', baseBranch: 'main' });
    const novelty = (await runFindingsNovelty(db as any, again))!;
    expect(novelty.baseBranch).toBe('main');
    expect(novelty.findings.every((f) => f.isNew)).toBe(true);

    await recordRunResourceFindings(db as any, await run({ leaky: true, branch: null }));
    const later = await run({ leaky: true, branch: 'feature/login', baseBranch: 'main' });
    expect((await runFindingsNovelty(db as any, later))!.findings.some((f) => f.isNew)).toBe(false);

    const resources = (await getRunResources(db as any, later))!;
    expect(resources.baseBranch).toBe('main');
    expect(Object.values(resources.history)).toHaveLength(4);
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
    await saveResourceReportPart(db as any, 50, report(null, true));
    const older = await run({ leaky: true });
    await recordRunResourceFindings(db as any, older);
    expect((await runFindingsNovelty(db as any, 50))!.findings.every((f) => !f.isNew)).toBe(true);
    expect((await runFindingsNovelty(db as any, older))!.findings.every((f) => f.isNew)).toBe(true);
    await recordRunResourceFindings(db as any, 50);
    expect((await listResourceFindings(db as any, 1, { verdict: 'leaked' }))[0]).toMatchObject({
      firstSeenRunId: older,
      lastSeenRunId: 50,
    });
  });

  /** A context left open at a line of the cart spec. */
  const leakAt = (line: number): WireResourceFinding => ({
    verdict: 'leaked',
    kind: 'context',
    where: `tests/cart.spec.ts:${line}`,
    site: `tests/cart.spec.ts:${line}`,
    scope: 'test',
    tests: 1,
    count: 1,
    heldMs: 1000,
  });

  test('counts each opening line on its own, however many share a file', async () => {
    const id = await run({ leaky: true, findings: [leakAt(10), leakAt(40)] });
    expect((await runFindingsNovelty(db as any, id))!.findings.map((f) => f.finding.site)).toEqual([
      'tests/cart.spec.ts:10',
      'tests/cart.spec.ts:40',
    ]);
    await recordRunResourceFindings(db as any, id);
    expect(await listResourceFindings(db as any, 1)).toHaveLength(2);
  });

  test('a leak an edit above its line moved keeps its history and is not new', async () => {
    const onMain = await run({ leaky: true, findings: [leakAt(10)] });
    await recordRunResourceFindings(db as any, onMain);
    const moved = await run({ leaky: true, branch: 'feature/cart', baseBranch: 'main', findings: [leakAt(12)] });
    expect((await runFindingsNovelty(db as any, moved))!.findings[0]!.isNew).toBe(false);
    await recordRunResourceFindings(db as any, moved);
    expect(await listResourceFindings(db as any, 1)).toEqual([
      expect.objectContaining({ where: 'tests/cart.spec.ts:12', firstSeenRunId: onMain, runs: 2 }),
    ]);
  });

  test('a new line in a file that already leaked on the base branch is new', async () => {
    await recordRunResourceFindings(db as any, await run({ leaky: true, findings: [leakAt(10)] }));
    const id = await run({
      leaky: true,
      branch: 'feature/cart',
      baseBranch: 'main',
      findings: [leakAt(10), leakAt(40)],
    });
    expect((await runFindingsNovelty(db as any, id))!.findings.map((f) => [f.finding.site, f.isNew])).toEqual([
      ['tests/cart.spec.ts:10', false],
      ['tests/cart.spec.ts:40', true],
    ]);
  });

  test('pairs a moved finding with the closest line of its group, each candidate once', () => {
    const fp = (line: number) => ({ fingerprint: resourceFingerprint(leakAt(line)) });
    const [at12, at52, at90] = [fp(12), fp(52), fp(90)];
    const [from10, from50] = [fp(10), fp(50)];
    const pairs = pairMoved([at52, at12, at90], [from50, from10]);
    expect(pairs.get(at12)).toBe(from10);
    expect(pairs.get(at52)).toBe(from50);
    expect(pairs.has(at90)).toBe(false);
  });

  test('says nothing about a run that sent no report', async () => {
    await db.insert(schema.testRuns).values({ id: 99, projectId: 1, status: 'passed', startTime: new Date() });
    expect(await runFindingsNovelty(db as any, 99)).toBeNull();
    expect(await recordRunResourceFindings(db as any, 99)).toEqual({ seen: 0, fixed: [], reopened: [] });
  });
});
