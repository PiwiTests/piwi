import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const stored = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    mkdir: async () => {},
    writeFile: async (path: string, data: Buffer) => void stored.set(path, data),
    readFile: async (path: string) => {
      const data = stored.get(path);
      if (!data) throw new Error(`missing ${path}`);
      return data;
    },
  }),
}));

const { FLAKE_LAB_RUN_METADATA_KEY } = await import('#shared/handlers/probes');
const { runOrigin } = await import('#shared/run-eligibility');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { getBranchFailures } = await import('../../server/utils/branch-failures');
const { resolveSelectionDefinition } = await import('#shared/handlers/selections');
const { getBuiltinSelection } = await import('#shared/selection');
const { getSelectionSuggestions } = await import('#shared/handlers/selection-suggestions');
const { computeChangeCoverage } = await import('#shared/handlers/change-coverage');
const { HISTORY_WINDOW_RUNS } = await import('#shared/handlers/scenario-gaps');
const { getEnvironmentDiff } = await import('../../server/utils/environment-diff');
const { getPageDiff } = await import('../../server/utils/page-diff');
const { getOrComputeVisualDiff } = await import('../../server/utils/visual-diff');
const { getAriaSampling, GREEN_SAMPLE_MAX_AGE_MS } = await import('#shared/handlers/aria-sampling');
const { getLastPassPageState } = await import('#shared/handlers/test-cases');
const { baselineComparisonSection } = await import('../../server/utils/ai-context');

type Db = ReturnType<typeof drizzle<typeof schema>>;

const PROJECT_ID = 1;
const GREEN_ARIA = '- document:\n  - form "Checkout":\n    - button "Pay now"';
const LAB_ARIA = '- document:\n  - form "Checkout":\n    - button "Lab order"';
const FAILING_ARIA = '- document:\n  - form "Checkout":\n    - button "Place order"';
const PAY_ERROR = [
  'Error: locator.click: Timeout 2000ms exceeded.',
  'Call log:',
  "  - waiting for getByRole('button', { name: 'Pay now' })",
  '',
  '    at /repo/tests/checkout.spec.ts:8:3',
].join('\n');
const BROWSE_ERROR = 'Error: expect(locator).toBeVisible() failed\n\n    at /repo/tests/browse.spec.ts:5:3';

async function freshDb(): Promise<Db> {
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: PROJECT_ID, name: 'lab-runs' });
  testCaseCache.invalidate(PROJECT_ID);
  testSuiteCache.invalidate(PROJECT_ID);
  return db;
}

function flakeArmMetadata(arm: number) {
  return { [FLAKE_LAB_RUN_METADATA_KEY]: { experimentId: 'exp-1', armId: `arm-${arm}` }, scm: { branch: 'main' } };
}

/** The metadata of each kind of run that replays tests away from the branch's current state. */
const REPLAYS = {
  'Flake Lab arms': flakeArmMetadata,
  'desktop bisect steps': (step: number) => ({
    piwiOrigin: { kind: 'bisect', ref: '214' },
    scm: { branch: 'main', commit: `bisect-${step}` },
  }),
  'desktop reproductions': (attempt: number) => ({
    piwiOrigin: { kind: 'reproduce', ref: '214' },
    scm: { branch: 'main', commit: `repro-${attempt}` },
  }),
};

async function addRun(
  db: Db,
  run: { id: number; startTime: Date; status: string; metadata?: Record<string, unknown> },
): Promise<void> {
  const metadata = run.metadata ?? { scm: { branch: 'main' } };
  await db.insert(schema.testRuns).values({
    id: run.id,
    projectId: PROJECT_ID,
    status: run.status,
    branch: 'main',
    startTime: run.startTime,
    totalTests: 2,
    metadata,
    origin: runOrigin(metadata),
  });
}

function snapshot(name: string) {
  return {
    location: 'tests/checkout.spec.ts:8:3',
    used: { method: 'getByRole', args: ['button', { name }], raw: `getByRole('button', { name: '${name}' })` },
    element: {
      tagName: 'button',
      attributes: { type: 'submit' },
      textContent: name,
      accessibleName: name,
      center: { x: 10, y: 10 },
    },
    alternatives: [],
  };
}

function pays(status: string, extra: Record<string, unknown> = {}) {
  return {
    title: 'pays',
    filePath: 'tests/checkout.spec.ts',
    location: 'tests/checkout.spec.ts:7:1',
    line: 7,
    browser: 'chromium',
    status,
    duration: 1000,
    ...extra,
  };
}

function browses(status: string, extra: Record<string, unknown> = {}) {
  return {
    title: 'browses',
    filePath: 'tests/browse.spec.ts',
    location: 'tests/browse.spec.ts:3:1',
    line: 3,
    browser: 'chromium',
    status,
    duration: 500,
    ...extra,
  };
}

async function png(color: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } })
    .png()
    .toBuffer();
}

async function attachScreenshot(
  db: Db,
  runId: number,
  executionId: number,
  path: string,
  color: [number, number, number],
) {
  stored.set(path, await png(color));
  await db.insert(schema.files).values({ testRunId: runId, testRunsCaseId: executionId, type: 'screenshot', path });
}

describe.each(Object.entries(REPLAYS))('twelve %s after a CI run', (_kind, replayMetadata) => {
  let db: Db;
  let failingPayId: number;
  const LAB_ARMS = 12;

  beforeAll(async () => {
    db = await freshDb();

    // CI, run 1: both tests pass.
    await addRun(db, { id: 1, startTime: new Date('2026-09-01T10:00:00Z'), status: 'passed' });
    const ciPass = await persistRunCases(db as never, PROJECT_ID, 1, [
      pays('passed', {
        ariaSnapshot: GREEN_ARIA,
        pageState: { url: 'https://shop.test/checkout', cookies: [{ name: 'session' }] },
        locatorSnapshots: [snapshot('Pay now')],
        tags: ['checkout'],
        locks: ['payments'],
      }),
      browses('passed'),
    ] as never);
    await attachScreenshot(db, 1, ciPass.find((r) => r.inputIndex === 0)!.id, 'shots/ci-pass.png', [255, 255, 255]);

    // CI, run 2: `pays` fails.
    await addRun(db, { id: 2, startTime: new Date('2026-09-02T10:00:00Z'), status: 'failed' });
    const ciFail = await persistRunCases(db as never, PROJECT_ID, 2, [
      pays('failed', { error: PAY_ERROR, ariaSnapshot: FAILING_ARIA, tags: ['checkout'], locks: ['payments'] }),
      browses('passed'),
    ] as never);
    failingPayId = ciFail.find((r) => r.inputIndex === 0)!.id;
    await attachScreenshot(db, 2, failingPayId, 'shots/ci-fail.png', [0, 0, 0]);

    // The CI samples are two days old, so each lab arm stores its own green sample.
    await db
      .update(schema.testRunsCases)
      .set({ createdAt: new Date(Date.now() - 2 * GREEN_SAMPLE_MAX_AGE_MS) })
      .where(inArray(schema.testRunsCases.testRunId, [1, 2]));

    // Twelve Flake Lab arms, all newer: `pays` passes under injected
    // conditions, `browses` fails under them.
    for (let arm = 0; arm < LAB_ARMS; arm++) {
      const runId = 10 + arm;
      await addRun(db, {
        id: runId,
        startTime: new Date(Date.parse('2026-09-03T10:00:00Z') + arm * 60_000),
        status: 'failed',
        metadata: replayMetadata(arm),
      });
      const rows = await persistRunCases(db as never, PROJECT_ID, runId, [
        pays('passed', {
          ariaSnapshot: LAB_ARIA,
          pageState: { url: 'https://shop.test/lab', cookies: [] },
          locatorSnapshots: [snapshot('Lab order')],
          tags: ['lab-arm'],
          locks: [],
        }),
        browses('failed', { error: BROWSE_ERROR }),
      ] as never);
      await attachScreenshot(db, runId, rows.find((r) => r.inputIndex === 0)!.id, `shots/lab-${arm}.png`, [255, 0, 0]);
    }
  });

  test("the editor's CI failures stay those of the CI run", async () => {
    const result = await getBranchFailures(db as never, PROJECT_ID, 'main');
    expect(result.run?.id).toBe(2);
    expect(result.failures.map((f) => f.title)).toEqual(['pays']);
  });

  test('the failed selection holds the test that failed in CI, not the one a lab arm failed', async () => {
    const resolved = await resolveSelectionDefinition(
      db as never,
      PROJECT_ID,
      getBuiltinSelection('failed')!.definition,
    );
    expect(resolved.tests.map((t) => t.title)).toEqual(['pays']);
  });

  test('the environment diff compares against the CI pass', async () => {
    const result = await getEnvironmentDiff(db as never, failingPayId);
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.baseline.runId).toBe(1);
  });

  test('the page diff compares against the CI pass', async () => {
    const result = await getPageDiff(db as never, failingPayId);
    expect(result.status).toBe('ok');
    expect(result.baseline?.runId).toBe(1);
  });

  test('the visual diff compares against the CI pass', async () => {
    const result = await getOrComputeVisualDiff(db as never, failingPayId);
    expect(result.status).toBe('ok');
    expect(result.diff).toMatchObject({ baselineRunId: 1, baselinePath: 'shots/ci-pass.png' });
  });

  test("the app-state baseline is the CI pass's page state", async () => {
    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    const state = await getLastPassPageState(db as never, { testCaseId: testCase!.id, browserName: 'chromium' });
    expect(state).toMatchObject({ url: 'https://shop.test/checkout' });
  });

  test('the locator snapshots stay those the CI run captured', async () => {
    const rows = await db.select().from(schema.locatorSnapshots);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.usedArgs)).toEqual(['button', { name: 'Pay now' }]);
  });

  test("the tests' tags and locks stay those the CI runs declared", async () => {
    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    expect(testCase).toMatchObject({ tags: ['checkout'], locks: ['payments'] });
  });

  test("the AI's baseline comparison does not call the cluster already green", async () => {
    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    const result = await baselineComparisonSection(
      db as never,
      { testCaseId: testCase!.id, duration: 1000, webVitals: null, consoleLogs: null, steps: null } as never,
      2,
    );
    expect(result.alreadyGreen).toBe(false);
    expect(result.section).toContain('Last passed: run #1');
  });
});

describe("the AI's baseline comparison", () => {
  async function lastPassedFixture(passBranch: string) {
    const db = await freshDb();
    await db.insert(schema.testCases).values({ id: 1, projectId: PROJECT_ID, filePath: 'tests/a.spec.ts', title: 'a' });
    await db.insert(schema.testRuns).values([
      // Run 5 is the failing run, started after run 7, which passed on another branch.
      { id: 5, projectId: PROJECT_ID, status: 'failed', branch: 'main', startTime: new Date('2026-09-02T10:00:00Z') },
      { id: 7, projectId: PROJECT_ID, status: 'passed', branch: 'main', startTime: new Date('2026-09-01T10:00:00Z') },
      {
        id: 8,
        projectId: PROJECT_ID,
        status: 'passed',
        branch: passBranch,
        startTime: new Date('2026-09-03T10:00:00Z'),
      },
    ]);
    await db.insert(schema.testRunsCases).values([
      { testRunId: 5, testCaseId: 1, status: 'failed' },
      { testRunId: 7, testCaseId: 1, status: 'passed' },
      { testRunId: 8, testCaseId: 1, status: 'passed' },
    ]);
    return db;
  }

  test('reads run order from start times, not run ids', async () => {
    const db = await lastPassedFixture('feature/other');
    const result = await baselineComparisonSection(db as never, { testCaseId: 1, duration: 10 } as never, 5);
    expect(result.alreadyGreen).toBe(false);
  });

  test("calls the cluster already green after a pass on the failing run's branch", async () => {
    const db = await lastPassedFixture('main');
    const result = await baselineComparisonSection(db as never, { testCaseId: 1, duration: 10 } as never, 5);
    expect(result.alreadyGreen).toBe(true);
    expect(result.section).toContain('run #8');
  });
});

/** Count the project's spec files in the change: a scope with no exclude. */
async function scopeEveryFile(db: Awaited<ReturnType<typeof freshDb>>) {
  await db
    .update(schema.projects)
    .set({ coverageScope: { include: [], exclude: [] } })
    .where(eq(schema.projects.id, PROJECT_ID));
}

describe('change coverage and partial runs', () => {
  test('counts complete runs only: a filtered run that skipped a file says nothing about it', async () => {
    const db = await freshDb();
    await addRun(db, { id: 1, startTime: new Date('2026-09-01T10:00:00Z'), status: 'passed' });
    await persistRunCases(db as never, PROJECT_ID, 1, [pays('passed'), browses('passed')] as never);
    for (let i = 0; i < HISTORY_WINDOW_RUNS; i++) {
      const id = 10 + i;
      await addRun(db, { id, startTime: new Date(Date.parse('2026-09-02T10:00:00Z') + i * 60_000), status: 'passed' });
      await db.update(schema.testRuns).set({ isFullRun: 0 }).where(eq(schema.testRuns.id, id));
      await persistRunCases(db as never, PROJECT_ID, id, [pays('passed')] as never);
    }

    await scopeEveryFile(db);
    const coverage = await computeChangeCoverage(db as never, PROJECT_ID, {
      changedFiles: [{ filePath: 'tests/browse.spec.ts', additions: 3, deletions: 1 }],
    });
    expect(coverage.files[0]).toMatchObject({
      filePath: 'tests/browse.spec.ts',
      reach: 'reached',
      reachedCountHistory: 1,
    });
    expect(coverage.uncoveredFiles).toBe(0);
  });
});

describe('change coverage after a Flake Lab session', () => {
  test('counts the CI runs that reached a file, not lab arms that ran another test', async () => {
    const db = await freshDb();
    await addRun(db, { id: 1, startTime: new Date('2026-09-01T10:00:00Z'), status: 'passed' });
    await persistRunCases(db as never, PROJECT_ID, 1, [pays('passed'), browses('passed')] as never);
    // A session long enough to fill the history window, each arm running one test.
    for (let arm = 0; arm < HISTORY_WINDOW_RUNS; arm++) {
      await addRun(db, {
        id: 10 + arm,
        startTime: new Date(Date.parse('2026-09-02T10:00:00Z') + arm * 60_000),
        status: 'passed',
        metadata: flakeArmMetadata(arm),
      });
      await persistRunCases(db as never, PROJECT_ID, 10 + arm, [pays('passed')] as never);
    }

    await scopeEveryFile(db);
    const coverage = await computeChangeCoverage(db as never, PROJECT_ID, {
      changedFiles: [{ filePath: 'tests/browse.spec.ts', additions: 3, deletions: 1 }],
    });
    expect(coverage.files[0]).toMatchObject({
      filePath: 'tests/browse.spec.ts',
      reach: 'reached',
      reachedCountHistory: 1,
    });
    expect(coverage.uncoveredFiles).toBe(0);
  });
});

describe('selection suggestions after Flake Lab arms', () => {
  test('lab durations do not mark a test slow', async () => {
    const db = await freshDb();
    await addRun(db, { id: 1, startTime: new Date('2026-09-01T10:00:00Z'), status: 'passed' });
    await persistRunCases(
      db as never,
      PROJECT_ID,
      1,
      Array.from({ length: 21 }, (_, i) => ({
        title: `t${i}`,
        filePath: `tests/t${i}.spec.ts`,
        location: `tests/t${i}.spec.ts:1:1`,
        browser: 'chromium',
        status: 'passed',
        duration: 100,
      })) as never,
    );
    // Arms that slow the network down: the same test takes a minute each time.
    for (let arm = 0; arm < 12; arm++) {
      await addRun(db, {
        id: 10 + arm,
        startTime: new Date(Date.parse('2026-09-02T10:00:00Z') + arm * 60_000),
        status: 'passed',
        metadata: flakeArmMetadata(arm),
      });
      await persistRunCases(db as never, PROJECT_ID, 10 + arm, [
        {
          title: 't0',
          filePath: 'tests/t0.spec.ts',
          location: 'tests/t0.spec.ts:1:1',
          browser: 'chromium',
          status: 'passed',
          duration: 60_000,
        },
      ] as never);
    }

    const { tags } = await getSelectionSuggestions(db as never, PROJECT_ID);
    expect(tags.filter((t) => t.kind === 'slow')).toEqual([]);
  });
});

describe('green ARIA samples next to lab runs', () => {
  let db: Db;
  const now = Date.parse('2026-09-10T12:00:00Z');

  beforeEach(async () => {
    db = await freshDb();
    await db.insert(schema.testCases).values({ id: 1, projectId: PROJECT_ID, filePath: 'tests/a.spec.ts', title: 'a' });
    // A CI sample two days old, and a lab arm's sample from an hour ago.
    await db.insert(schema.testRuns).values(
      [
        { id: 1, projectId: PROJECT_ID, status: 'passed', startTime: new Date(now - 2 * GREEN_SAMPLE_MAX_AGE_MS) },
        {
          id: 2,
          projectId: PROJECT_ID,
          status: 'passed',
          startTime: new Date(now - 3_600_000),
          metadata: flakeArmMetadata(0),
        },
      ].map((row) => ({ ...row, origin: runOrigin(row.metadata) })),
    );
    await db.insert(schema.testRunsCases).values([
      {
        testRunId: 1,
        testCaseId: 1,
        status: 'passed',
        ariaSnapshot: GREEN_ARIA,
        createdAt: new Date(now - 2 * GREEN_SAMPLE_MAX_AGE_MS),
      },
      { testRunId: 2, testCaseId: 1, status: 'passed', ariaSnapshot: LAB_ARIA, createdAt: new Date(now - 3_600_000) },
    ]);
  });

  test('a test whose only fresh sample came from a lab run is due another', async () => {
    const { tests } = await getAriaSampling(db as never, PROJECT_ID, now);
    expect(tests).toEqual([{ filePath: 'tests/a.spec.ts', title: 'a' }]);
  });

  test("a CI run's green sample is kept when only a lab run sampled the test today", async () => {
    await db.insert(schema.testRuns).values({ id: 3, projectId: PROJECT_ID, status: 'passed', startTime: new Date() });
    await db.update(schema.testRunsCases).set({ createdAt: new Date() }).where(eq(schema.testRunsCases.testRunId, 2));
    const [row] = await persistRunCases(db as never, PROJECT_ID, 3, [
      {
        title: 'a',
        filePath: 'tests/a.spec.ts',
        location: 'tests/a.spec.ts:1:1',
        status: 'passed',
        ariaSnapshot: GREEN_ARIA,
      },
    ] as never);
    const [stored] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.id, row!.id));
    expect(stored!.ariaSnapshotPayloadId).not.toBeNull();
  });
});

describe("the editor's CI failures next to local runs", () => {
  test('a newer complete local run stands in only while the branch has no CI run', async () => {
    const db = await freshDb();
    await addRun(db, { id: 1, startTime: new Date('2026-09-01T10:00:00Z'), status: 'passed' });
    await persistRunCases(db as never, PROJECT_ID, 1, [pays('passed'), browses('passed')] as never);
    await addRun(db, {
      id: 2,
      startTime: new Date('2026-09-02T10:00:00Z'),
      status: 'failed',
      metadata: { piwiOrigin: { kind: 'local' }, scm: { branch: 'main' } },
    });
    await persistRunCases(db as never, PROJECT_ID, 2, [
      pays('failed', { error: PAY_ERROR }),
      browses('passed'),
    ] as never);

    // Run 1 has no origin and no CI record: it reads as a local run, the newest of which stands in.
    expect((await getBranchFailures(db as never, PROJECT_ID, 'main')).run?.id).toBe(2);

    const ciMetadata = { piwiOrigin: { kind: 'ci' }, scm: { branch: 'main' } };
    await db
      .update(schema.testRuns)
      .set({ metadata: ciMetadata, origin: runOrigin(ciMetadata) })
      .where(eq(schema.testRuns.id, 1));
    const result = await getBranchFailures(db as never, PROJECT_ID, 'main');
    expect(result.run?.id).toBe(1);
    expect(result.failures).toEqual([]);
  });
});
