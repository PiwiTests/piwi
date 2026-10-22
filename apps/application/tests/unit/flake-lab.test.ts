import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { flakeErrorSignature } from '@piwitests/core/flake-plan';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { routePermissionList } from '#shared/permissions';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handlers.
delete process.env.PIWI_DATABASE_URL;
const lab = await import('../../shared/handlers/flake-lab');
const { getFlakeProfileSummaries } = await import('../../shared/handlers/flake-profile');
const { deleteRunsByIds } = await import('../../server/utils/retention');

const NOW = new Date('2026-09-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const FLAKY = 1;
const NEIGHBOR = 2;
const OTHER_PROJECT_CASE = 9;
const CART_ERROR =
  'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected: "$42.00"';

let db: ReturnType<typeof drizzle<typeof schema>>;
let client: ReturnType<typeof createClient>;
let tmpDir: string;

/**
 * Twelve runs of the flaky test: in runs 1–5 it fails with a slow cart while
 * the neighbor runs beside it; in runs 6–12 it passes with a fast cart and the
 * neighbor runs after it. Run 1 carries a commit.
 */
beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-flake-lab-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  await client.execute('PRAGMA foreign_keys=ON');
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });

  await db.insert(schema.projects).values([
    { id: 1, name: 'Shop', defaultBranch: 'main' },
    { id: 2, name: 'Other' },
  ]);
  await db.insert(schema.testCases).values([
    {
      id: FLAKY,
      projectId: 1,
      title: 'pays with a saved card',
      filePath: 'tests/checkout.spec.ts',
      suitePath: 'checkout',
    },
    {
      id: NEIGHBOR,
      projectId: 1,
      title: 'resets catalog',
      filePath: 'tests/admin.spec.ts',
      suitePath: 'admin\x1fcatalog',
    },
    { id: OTHER_PROJECT_CASE, projectId: 2, title: 'x', filePath: 'x.spec.ts' },
  ]);
  let executionId = 1;
  for (let run = 1; run <= 12; run++) {
    const fails = run <= 5;
    const start = NOW.getTime() - run * DAY;
    await db.insert(schema.testRuns).values({
      id: run,
      projectId: 1,
      status: fails ? 'failed' : 'passed',
      startTime: new Date(start),
      duration: 60_000,
      branch: 'main',
      metadata: run === 1 ? { scm: { commit: 'abc1234' } } : null,
    });
    const flaky = executionId++;
    await db.insert(schema.testRunsCases).values([
      {
        id: flaky,
        testRunId: run,
        testCaseId: FLAKY,
        status: fails ? 'failed' : 'passed',
        error: fails ? CART_ERROR : null,
        startedAt: start + 1_000,
        duration: fails ? 6_000 : 4_000,
        workerIndex: 0,
        line: 12,
        browserName: 'chromium',
        createdAt: new Date(start),
      },
      {
        id: executionId++,
        testRunId: run,
        testCaseId: NEIGHBOR,
        status: 'passed',
        startedAt: fails ? start + 2_000 : start + 30_000,
        duration: 3_000,
        workerIndex: 1,
        line: 30,
        browserName: 'chromium',
        createdAt: new Date(start),
      },
    ]);
    await db.insert(schema.networkRequests).values({
      testRunsCaseId: flaky,
      testRunId: run,
      method: 'GET',
      url: 'https://shop.test/api/cart',
      status: 200,
      duration: fails ? 1_800 : 150,
    });
  }
});

afterAll(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the reproduce plan', () => {
  test('orders the arms by suspect rank after a control, in the plan-file shape', async () => {
    const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW });
    expect(plan.experimentId).toBeNull();
    expect(plan.test).toEqual({
      file: 'tests/checkout.spec.ts',
      title: 'pays with a saved card',
      suite: ['checkout'],
      project: 'chromium',
    });
    expect(plan.displayTitle).toBe('checkout › pays with a saved card');
    expect(plan.control).toMatchObject({ id: 'control', conditions: [], runs: 10, stopAt: null });
    expect(plan.arms.map((a) => a.id)).toEqual(plan.suspects.map((s) => `suspect-${s.rank}`));
    expect(plan.arms[0]).toMatchObject({
      suspectId: 'slow-route:GET /api/cart',
      conditions: [{ kind: 'delay', route: 'GET /api/cart', ms: 1800, match: 'all' }],
      label: 'delay GET /api/cart 1.8 s',
      runs: 10,
      stopAt: 3,
    });
  });

  test('names the alongside test by file, title and describe path', async () => {
    const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW });
    const alongside = plan.arms.find((a) => a.suspectId === `alongside:${NEIGHBOR}`);
    expect(alongside?.conditions).toEqual([
      {
        kind: 'alongside',
        test: { file: 'tests/admin.spec.ts', title: 'resets catalog', suite: ['admin', 'catalog'] },
      },
    ]);
    // The neighbor also counts as load, so the combination throttles the CPU too.
    expect(plan.combined?.conditions.map((c) => c.kind).sort()).toEqual(['alongside', 'cpu', 'delay']);
  });

  test('carries the signatures of the failures, the failure commit and the median pass', async () => {
    const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW });
    expect(plan.errorSignatures).toEqual([flakeErrorSignature(CART_ERROR)]);
    expect(plan.failureCommit).toBe('abc1234');
    expect(plan.medianDurationMs).toBe(4_000);
    expect(plan.failures).toBe(5);
  });

  test('records an experiment only when asked', async () => {
    const before = await db.select().from(schema.flakeExperiments);
    const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, {
      now: NOW,
      record: true,
      commit: 'def5678',
      machine: 'laptop',
    });
    const rows = await db.select().from(schema.flakeExperiments);
    expect(rows).toHaveLength(before.length + 1);
    const row = rows.find((r) => String(r.id) === plan.experimentId)!;
    expect(row).toMatchObject({ kind: 'reproduce', commit: 'def5678', failureCommit: 'abc1234', machine: 'laptop' });
    expect(row.finishedAt).toBeNull();
  });

  test('skips a suspect whose other test is unknown', () => {
    const plan = lab.buildFlakeReproducePlan({
      testCaseId: 1,
      projectId: 1,
      test: { file: 'a.spec.ts', title: 'a', suite: [], project: null },
      profile: {
        testCaseId: 1,
        windowDays: 30,
        maxAttempts: 200,
        attempts: 10,
        failures: 4,
        passes: 6,
        from: null,
        to: null,
        context: [],
        suspects: [
          {
            id: 'before:77',
            kind: 'before',
            label: 'gone just before',
            sentence: '',
            counts: { failuresWith: 4, failures: 4, passesWith: 0, passes: 6 },
            lift: 5,
            condition: { kind: 'after', testCaseId: 77, title: 'gone' },
            conditionLabel: 'run it first',
            executionIds: [],
          },
        ],
      },
      others: new Map(),
      failureCommit: null,
      medianDurationMs: null,
      errorSignatures: [],
    });
    expect(plan.arms).toEqual([]);
    expect(plan.suspects[0]!.skipped).toMatch(/no longer in the catalog/);
    expect(plan.combined).toBeNull();
  });

  test('gives the next step its facts: reproduce under the top untested suspect', async () => {
    const facts = await lab.getFlakeLabStepFacts(db as never, FLAKY, { ciAvailable: true, now: NOW });
    const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW });
    expect(facts).toEqual({
      testCaseId: FLAKY,
      nextStep: 'reproduce',
      command: `npx @piwitests/reporter flake ${FLAKY}`,
      reproducedBy: null,
      suspect: { id: plan.suspects[0]!.id, label: plan.suspects[0]!.label, standing: 'untested' },
      untestedSuspects: plan.suspects.length,
      ciAvailable: true,
    });
  });

  test('runs the untested suspects first and a suspect that did not reproduce last, explained', async () => {
    const before = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW });
    const cart = 'slow-route:GET /api/cart';
    expect(before.arms[0]!.suspectId).toBe(cart);
    const [row] = await db
      .insert(schema.flakeExperiments)
      .values({
        projectId: 1,
        testCaseId: FLAKY,
        kind: 'reproduce',
        verdict: 'not-reproduced',
        source: 'cli',
        createdAt: NOW,
        finishedAt: NOW,
      })
      .returning({ id: schema.flakeExperiments.id });
    const arm = { experimentId: row!.id, conditions: [], runs: 10, matchingFailures: 0 };
    await db.insert(schema.flakeArms).values([
      { ...arm, armKey: 'control', position: 0, label: 'control' },
      { ...arm, armKey: 'suspect-1', position: 1, suspectId: cart, label: 'delay', verdict: 'not-reproduced' },
    ]);
    try {
      const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW });
      expect(plan.arms).toHaveLength(before.arms.length);
      expect(plan.arms.at(-1)!.suspectId).toBe(cart);
      expect(plan.arms[0]!.suspectId).not.toBe(cart);
      expect(plan.arms.find((a) => a.suspectId === cart)!.rank).toBe(1);
      expect(plan.suspects[0]).toMatchObject({ id: cart, rank: 1, lab: { verdict: 'not-reproduced', runs: 10 } });
      expect(plan.suspects[0]!.lab!.note).toMatch(/fewer than 26% of runs/);
      expect(plan.suspects[1]!.lab).toBeNull();

      const project = await lab.getProjectFlakeLab(db as never, 1, { suspects: true, now: NOW });
      const flaky = project.tests.find((t) => t.testCaseId === FLAKY)!;
      expect(flaky.suspect).toMatchObject({ standing: 'untested', lab: 'untested' });
      expect(flaky.suspect!.id).not.toBe(cart);
      expect(flaky.untestedSuspects).toBe(plan.suspects.length - 1);
      const plain = await lab.getProjectFlakeLab(db as never, 1, { now: NOW });
      expect(plain.tests.find((t) => t.testCaseId === FLAKY)!.suspect).toBeUndefined();
      // The server reads the profiles through its cache: one call for every listed test.
      const asked: number[][] = [];
      const kept = await lab.getProjectFlakeLab(db as never, 1, {
        suspects: true,
        now: NOW,
        profiles: async (ids) => {
          asked.push(ids);
          return getFlakeProfileSummaries(db as never, ids, { now: NOW });
        },
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(FLAKY);
      expect(kept.tests.find((t) => t.testCaseId === FLAKY)!.suspect).toEqual(flaky.suspect);
    } finally {
      await db.delete(schema.flakeExperiments).where(eq(schema.flakeExperiments.id, row!.id));
    }
  });

  test('refuses a verify plan before anything reproduced', async () => {
    await expect(lab.getFlakeExperimentPlan(db as never, 555_555, { now: NOW })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(lab.getFlakeExperimentPlan(db as never, NEIGHBOR, { now: NOW, kind: 'verify' })).rejects.toMatchObject(
      { statusCode: 409 },
    );
  });
});

describe('combining arms', () => {
  test('keeps one of each route condition, one worker condition and one project', () => {
    const t = { file: 'a', title: 'a', suite: [] };
    expect(
      lab.combineFlakeArms([
        { conditions: [{ kind: 'delay', route: 'GET /a', ms: 1000, match: 'all' }] },
        { conditions: [{ kind: 'alongside', test: t }] },
        { conditions: [{ kind: 'after', test: t }] },
        { conditions: [{ kind: 'delay', route: 'GET /a', ms: 2000, match: 'all' }] },
        { conditions: [{ kind: 'cpu', rate: 4 }] },
      ]),
    ).toEqual([
      { kind: 'delay', route: 'GET /a', ms: 1000, match: 'all' },
      { kind: 'alongside', test: t },
      { kind: 'cpu', rate: 4 },
    ]);
    expect(lab.combineFlakeArms([{ conditions: [{ kind: 'cpu', rate: 4 }] }])).toBeNull();
  });
});

const DELAY = [{ kind: 'delay', route: 'GET /api/cart', ms: 1800 }];

async function newExperiment(kind: 'reproduce' | 'verify' = 'reproduce'): Promise<string> {
  const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW, record: true, kind });
  return plan.experimentId!;
}

describe('recording results', () => {
  test('stores the verdicts the server computes, not the client’s', async () => {
    const experimentId = await newExperiment();
    const res = await lab.recordFlakeResults(db as never, 1, {
      experimentId,
      commit: 'fff0000',
      arms: [
        { id: 'control', conditions: [], runs: 10, matchingFailures: 0, otherFailures: 0 },
        {
          id: 'suspect-1',
          suspectId: 'slow-route:GET /api/cart',
          conditions: DELAY,
          runs: 4,
          matchingFailures: 3,
          otherFailures: 0,
          stoppedEarly: true,
          // A client-sent verdict is not part of the input and is never read.
          ...({ verdict: 'not-reproduced', pValue: 0.9 } as object),
        },
        {
          id: 'suspect-2',
          suspectId: `alongside:${NEIGHBOR}`,
          conditions: [{ kind: 'alongside', test: { file: 'tests/admin.spec.ts', title: 'resets catalog' } }],
          runs: 10,
          matchingFailures: 1,
          otherFailures: 2,
          discardedRounds: 3,
        },
      ],
    });
    expect(res.verdict).toBe('reproduced');
    expect(res.arms[1]!.verdict).toBe('reproduced');
    expect(res.arms[1]!.pValue).toBeCloseTo(0.011, 3);
    expect(res.arms[2]!.verdict).toBe('not-reproduced');

    const [experiment] = await db
      .select()
      .from(schema.flakeExperiments)
      .where(eq(schema.flakeExperiments.id, Number(experimentId)));
    expect(experiment).toMatchObject({ verdict: 'reproduced', commit: 'fff0000' });
    expect(experiment!.finishedAt).toBeInstanceOf(Date);
    const arms = await db
      .select()
      .from(schema.flakeArms)
      .where(eq(schema.flakeArms.experimentId, Number(experimentId)));
    const reproducing = arms.find((a) => a.id === experiment!.reproducingArmId)!;
    expect(reproducing).toMatchObject({ armKey: 'suspect-1', verdict: 'reproduced', stoppedEarly: true });
    expect(reproducing.label).toBe('delay GET /api/cart 1.8 s');
    expect(arms.find((a) => a.armKey === 'control')).toMatchObject({ verdict: null, pValue: null });
    expect(arms.find((a) => a.armKey === 'suspect-2')).toMatchObject({ discardedRounds: 3, otherFailures: 2 });
  });

  test('refuses a second post, another project, missing control and impossible counts', async () => {
    const experimentId = await newExperiment();
    const control = { id: 'control', conditions: [], runs: 10, matchingFailures: 0, otherFailures: 0 };
    await expect(lab.recordFlakeResults(db as never, 2, { experimentId, arms: [control] })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      lab.recordFlakeResults(db as never, 1, {
        experimentId,
        arms: [{ ...control, id: 'suspect-1', conditions: DELAY }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      lab.recordFlakeResults(db as never, 1, {
        experimentId,
        arms: [control, { id: 'suspect-1', conditions: DELAY, runs: 2, matchingFailures: 2, otherFailures: 1 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      lab.recordFlakeResults(db as never, 1, {
        experimentId,
        arms: [
          control,
          { id: 'suspect-1', conditions: [{ kind: 'teleport' }], runs: 2, matchingFailures: 0, otherFailures: 0 },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await lab.recordFlakeResults(db as never, 1, { experimentId, arms: [control] });
    await expect(lab.recordFlakeResults(db as never, 1, { experimentId, arms: [control] })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test('lists finished experiments newest first, with each suspect’s latest result', async () => {
    const experiments = await lab.listFlakeExperiments(db as never, FLAKY);
    expect(experiments.every((e) => e.finishedAt)).toBe(true);
    const results = lab.latestSuspectResults(experiments);
    expect(results.get('slow-route:GET /api/cart')).toMatchObject({
      verdict: 'reproduced',
      runs: 4,
      matchingFailures: 3,
      controlRuns: 10,
    });
    const [summary] = await lab.getFlakeLabSummaries(db as never, [FLAKY]);
    // The newest finished reproduce experiment is the control-only one above.
    expect(summary).toMatchObject({ testCaseId: FLAKY, verdict: 'not-reproduced' });
  });

  test('an arm recorded against a load suspect with its threshold counts as the load suspect', () => {
    const arm = (suspectId: string, verdict: string) => ({
      key: suspectId,
      label: 'CPU ×4',
      suspectId,
      verdict,
      runs: 4,
      matchingFailures: 3,
      pValue: 0.01,
    });
    const experiment = (id: number, arms: unknown[]) =>
      ({ id, kind: 'reproduce', finishedAt: null, arms }) as unknown as Parameters<
        typeof lab.latestSuspectResults
      >[0][0];
    const results = lab.latestSuspectResults([
      experiment(2, [arm('load', 'not-reproduced')]),
      experiment(1, [arm('load:3', 'reproduced')]),
    ]);
    expect([...results.keys()]).toEqual(['load']);
    expect(results.get('load')).toMatchObject({ experimentId: 2, verdict: 'not-reproduced' });
    expect(lab.latestSuspectResults([experiment(1, [arm('load:7', 'reproduced')])]).get('load')).toMatchObject({
      verdict: 'reproduced',
    });
  });

  test('the flaky list names a reproduced suspect over a higher-ranked one', async () => {
    const { getTopFlakeSuspects } = await import('../../shared/handlers/flake-profile');
    const [ranked] = await getTopFlakeSuspects(db as never, 1, [FLAKY], { now: NOW });
    expect(ranked!.suspect!.id).toBe('slow-route:GET /api/cart');

    const result = (suspectId: string, verdict: 'reproduced' | 'not-reproduced') => ({
      suspectId,
      experimentId: 1,
      verdict,
      runs: 10,
      matchingFailures: verdict === 'reproduced' ? 7 : 0,
      controlRuns: 10,
      controlMatchingFailures: 0,
      pValue: null,
      label: suspectId,
      finishedAt: null,
    });
    const reproduced = new Map([
      [FLAKY, new Map([[`alongside:${NEIGHBOR}`, result(`alongside:${NEIGHBOR}`, 'reproduced')]])],
    ]);
    const [preferred] = await getTopFlakeSuspects(db as never, 1, [FLAKY], { now: NOW, results: reproduced });
    expect(preferred!.suspect!.id).toBe(`alongside:${NEIGHBOR}`);

    // A higher-ranked suspect that did not reproduce gives way to the next untested one, and stays listed.
    const cart = 'slow-route:GET /api/cart';
    const demoted = new Map([[FLAKY, new Map([[cart, result(cart, 'not-reproduced')]])]]);
    const [next] = await getTopFlakeSuspects(db as never, 1, [FLAKY], { now: NOW, results: demoted });
    expect(next!.suspect!.id).not.toBe(cart);

    // The list reads each test's lab results: the cart suspect reproduced earlier, so it leads. The list takes no
    // clock of its own, so the date is set to the fixture's.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      const [item] = await lab.getFlakyListSuspects(db as never, 1, [FLAKY]);
      expect(item!.suspect!.id).toBe('slow-route:GET /api/cart');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verify', () => {
  test('reruns the reproducing arm for the D9 runs and judges the fix', async () => {
    const plan = await lab.getFlakeExperimentPlan(db as never, FLAKY, { now: NOW, record: true, kind: 'verify' });
    // The arm reproduced 3 of 4 (rate 0.75): ⌈ln 0.05 / ln 0.25⌉ = 3, so the floor of 5.
    expect(plan.kind).toBe('verify');
    expect(plan.arms).toEqual([
      expect.objectContaining({ id: 'verify', conditions: [{ ...DELAY[0], match: 'all' }], runs: 5, stopAt: 1 }),
    ]);
    expect(plan.control.runs).toBe(5);
    expect(plan.verifies).toMatchObject({ rate: 0.75, label: 'delay GET /api/cart 1.8 s' });

    const arms = (verify: { runs: number; matchingFailures: number }) => [
      { id: 'control', conditions: [], runs: 5, matchingFailures: 0, otherFailures: 0 },
      { id: 'verify', conditions: DELAY, otherFailures: 0, ...verify },
    ];
    const held = await lab.recordFlakeResults(db as never, 1, {
      experimentId: plan.experimentId!,
      arms: arms({ runs: 5, matchingFailures: 0 }),
    });
    expect(held.verdict).toBe('verified');

    const again = await newExperiment('verify');
    const failed = await lab.recordFlakeResults(db as never, 1, {
      experimentId: again,
      arms: arms({ runs: 2, matchingFailures: 1 }),
    });
    expect(failed.verdict).toBe('still-fails');

    const short = await newExperiment('verify');
    expect(
      (
        await lab.recordFlakeResults(db as never, 1, {
          experimentId: short,
          arms: arms({ runs: 3, matchingFailures: 0 }),
        })
      ).verdict,
    ).toBe('inconclusive');

    const listed = await lab.listFlakeExperiments(db as never, FLAKY);
    const verified = listed.find((e) => e.id === Number(plan.experimentId))!;
    expect(verified.verifies).toMatchObject({ label: 'delay GET /api/cart 1.8 s' });

    // Only the verified verdict is the flake-verify hand-back's outcome.
    const outcomes = await db.select().from(schema.handbackOutcomes);
    expect(outcomes.map((o) => [o.kind, o.subjectType, o.subjectId, o.suggestionKey, o.outcome, o.channel])).toEqual([
      ['flake-verify', 'test-case', FLAKY, `experiment:${plan.experimentId}`, 'verified', 'cli'],
    ]);
  });
});

describe('the verdict rules', () => {
  test('reproduced needs the rate and the p-value, amplified only the p-value', () => {
    const control = { id: 'control', conditions: [], runs: 10, matchingFailures: 0, otherFailures: 0 };
    const judged = lab.judgeReproduce([
      control,
      { id: 'a', conditions: [], runs: 10, matchingFailures: 4, otherFailures: 0 },
      { id: 'b', conditions: [], runs: 4, matchingFailures: 3, otherFailures: 0 },
    ]);
    expect(judged.arms.map((a) => a.verdict)).toEqual([null, 'amplified', 'reproduced']);
    expect(judged).toMatchObject({ verdict: 'reproduced', reproducingArm: 'b' });
    expect(lab.judgeReproduce([control, { ...control, id: 'c', matchingFailures: 1 }]).verdict).toBe('not-reproduced');
  });
});

describe('finding a test by file and line', () => {
  test('picks the test declared on the line, or the last one before it', async () => {
    expect(await lab.resolveTestCaseByLocation(db as never, 1, 'tests/checkout.spec.ts', 12)).toMatchObject({
      testCaseId: FLAKY,
    });
    expect(await lab.resolveTestCaseByLocation(db as never, 1, 'checkout.spec.ts', 20)).toMatchObject({
      testCaseId: FLAKY,
      line: 12,
    });
    expect(await lab.resolveTestCaseByLocation(db as never, 1, 'tests/checkout.spec.ts', 5)).toBeNull();
    expect(await lab.resolveTestCaseByLocation(db as never, 2, 'tests/checkout.spec.ts', 12)).toBeNull();
  });
});

describe('what keeps and deletes experiments', () => {
  test('retention deleting the runs keeps them', async () => {
    const before = await db.select().from(schema.flakeExperiments);
    await deleteRunsByIds(db as unknown as DbClient, [12, 11]);
    expect(await db.select().from(schema.flakeExperiments)).toHaveLength(before.length);
  });

  test('deleting the test case deletes its experiments and their arms', async () => {
    expect((await db.select().from(schema.flakeArms)).length).toBeGreaterThan(0);
    await db.delete(schema.testCases).where(eq(schema.testCases.id, FLAKY));
    expect(await db.select().from(schema.flakeExperiments)).toHaveLength(0);
    expect(await db.select().from(schema.flakeArms)).toHaveLength(0);
  });
});

describe('the endpoints’ permissions', () => {
  const permission = (file: string) => {
    const source = readFileSync(fileURLToPath(new URL(`../../server/api/${file}`, import.meta.url)), 'utf8');
    const value = /'x-required-permission': ('[^']*'|\[[^\]]*\])/.exec(source)![1]!;
    return routePermissionList(JSON.parse(value.replace(/'/g, '"')));
  };

  test('the results are uploaded during a run, so they take what the probe results take', () => {
    const probes = permission('projects/[id]/probes/results.post.ts');
    expect(probes).toEqual(['run:submit']);
    expect(permission('projects/[id]/flake-lab/results.post.ts')).toEqual(probes);
  });

  test('the plan is open to the reporter during a run and to whoever controls runs', () => {
    expect(permission('test-cases/[id]/flake-plan.get.ts')).toEqual(['run:submit', 'run:control']);
  });

  test('reading experiments and finding a test take project:read', () => {
    expect(permission('test-cases/[id]/flake-experiments.get.ts')).toEqual(['project:read']);
    expect(permission('projects/[id]/flake-lab/test.get.ts')).toEqual(['project:read']);
  });
});
