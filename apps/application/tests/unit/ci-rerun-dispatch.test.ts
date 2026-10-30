import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const dispatched: Array<{ args: string; request: Record<string, unknown>; settings: unknown }> = [];
let answer: Record<string, unknown> = {};
vi.mock('../../server/utils/scm', () => ({
  detectScmProvider: (url: string | null) => (url?.includes('gitlab') ? 'gitlab' : url ? 'github' : null),
  resolveScmToken: async () => 'token',
  createScmProvider: async () => ({
    dispatchRerun: async (settings: unknown, args: string, request: Record<string, unknown>) => {
      dispatched.push({ args, request, settings });
      return { url: 'https://ci.example/runs', ref: request.ref ?? 'main', ...answer };
    },
  }),
}));

const { rerunClusterInCi, matchCiRerunRun, runFlakeLabInCi, flakeLabCiAvailability } =
  await import('../../server/utils/ci-rerun');
const { flakeLabRerunSettings, matchRerunDispatch, resolveCiRerunSettings, RERUN_MATCH_WINDOW_MS } =
  await import('#shared/ci-rerun');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const GITHUB = 'https://github.com/acme/shop.git';
const GITLAB = 'https://gitlab.com/acme/shop.git';

async function seed(remoteUrl: string) {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({
    id: 1,
    name: 'shop',
    ciRerun: {
      enabled: true,
      github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: 'piwi_dispatch' },
      gitlab: { ref: 'main', variableName: 'PW_ARGS' },
    },
  });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'refunds' },
    { id: 3, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'empties' },
  ]);
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    branch: 'feature/coupon',
    startTime: new Date('2026-09-01T10:00:00Z'),
    metadata: { scm: { remoteUrl, branch: 'feature/coupon' }, piwiOrigin: { kind: 'ci' } },
  });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp',
    signature: 'Error: declined',
    errorType: 'unknown',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testRunsCases).values([
    { testRunId: 1, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium', failureClusterId: 1 },
    { testRunId: 1, testCaseId: 2, status: 'failed', line: 30, browserName: 'chromium', failureClusterId: 1 },
  ]);
}

/** A finished CI run of the given tests, started `afterMs` after the dispatch. */
async function finishedRun(id: number, metadata: Record<string, unknown>, testCaseIds: number[], at: number) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    branch: 'feature/coupon',
    isFullRun: 0,
    startTime: new Date(at),
    metadata: { scm: { branch: 'feature/coupon' }, ...metadata },
  });
  await db
    .insert(schema.testRunsCases)
    .values(testCaseIds.map((testCaseId) => ({ testRunId: id, testCaseId, status: 'passed' })));
}

async function lastDispatch() {
  const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1));
  return row!.lastRerunDispatch as Record<string, any>;
}

async function originOf(runId: number) {
  const [row] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return (row!.metadata as Record<string, any>).piwiOrigin;
}

beforeEach(() => {
  dispatched.length = 0;
  answer = {};
});

describe('a CI re-run dispatch', () => {
  test("runs each affected test at its line, on the cluster's branch, with the dispatch id", async () => {
    await seed(GITHUB);
    const outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    expect(outcome.ok).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args).toBe('"tests/checkout.spec.ts:30" "tests/checkout.spec.ts:12" --project="chromium"');
    expect(dispatched[0]!.request.ref).toBe('feature/coupon');
    const record = await lastDispatch();
    expect(dispatched[0]!.request.dispatchId).toBe(record.id);
    expect(record).toMatchObject({
      provider: 'github',
      ref: 'feature/coupon',
      files: ['tests/checkout.spec.ts'],
      byName: 'Ada',
    });
  });

  test('keeps the pipeline id GitLab answers with', async () => {
    await seed(GITLAB);
    answer = { pipelineId: '9001' };
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    expect(await lastDispatch()).toMatchObject({ provider: 'gitlab', pipelineId: '9001' });
  });
});

describe('the run a CI re-run started', () => {
  test('is recognized by the dispatch id it carries, and stamped ci-rerun', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id } }, [1], at + 60_000);
    expect(await matchCiRerunRun(db as never, 2)).toBe(1);
    expect(await originOf(2)).toEqual({ kind: 'ci-rerun', ref: id });
    expect((await lastDispatch()).runId).toBe(2);
  });

  test("is recognized by GitLab's pipeline id", async () => {
    await seed(GITLAB);
    answer = { pipelineId: '9001' };
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci' }, ci: { provider: 'GitLab CI', pipelineId: '9000' } }, [1, 2], at);
    expect(await matchCiRerunRun(db as never, 2)).toBeNull();
    await finishedRun(3, { piwiOrigin: { kind: 'ci' }, ci: { provider: 'GitLab CI', pipelineId: '9001' } }, [1, 2], at);
    expect(await matchCiRerunRun(db as never, 3)).toBe(1);
    expect((await originOf(3)).kind).toBe('ci-rerun');
  });

  test('without an id, by its branch, start time and test files', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { at } = await lastDispatch();
    // Another file ran too: not the re-run.
    await finishedRun(2, { piwiOrigin: { kind: 'ci' } }, [1, 3], at + 60_000);
    expect(await matchCiRerunRun(db as never, 2)).toBeNull();
    // A local run of the same tests: not a CI run.
    await finishedRun(3, { piwiOrigin: { kind: 'local' } }, [1, 2], at + 60_000);
    expect(await matchCiRerunRun(db as never, 3)).toBeNull();
    await finishedRun(4, { piwiOrigin: { kind: 'ci' } }, [1, 2], at + 120_000);
    expect(await matchCiRerunRun(db as never, 4)).toBe(1);
    // Matched once only.
    await finishedRun(5, { piwiOrigin: { kind: 'ci' } }, [1, 2], at + 180_000);
    expect(await matchCiRerunRun(db as never, 5)).toBeNull();
  });
});

describe('matchRerunDispatch', () => {
  const base = { provider: 'github' as const, url: '', args: '', byName: null, byUserId: null };
  const run = {
    originRef: null,
    pipelineId: null,
    buildNumber: null,
    branch: 'main',
    startedAt: 1_000_000,
    files: ['tests/a.spec.ts'],
  };

  test("matches Bitbucket's build number", () => {
    const d = { ...base, provider: 'bitbucket' as const, id: 'x', at: 0, buildNumber: '42' };
    expect(matchRerunDispatch({ ...run, buildNumber: '42' }, [d])).toBe(d);
    expect(matchRerunDispatch({ ...run, buildNumber: '41' }, [d])).toBeNull();
  });

  test('leaves a run started outside the window or before the dispatch', () => {
    const d = { ...base, id: 'x', at: 1_000_000, ref: 'main', files: ['tests/a.spec.ts'] };
    expect(matchRerunDispatch({ ...run, startedAt: 999_000 }, [d])).toBeNull();
    expect(matchRerunDispatch({ ...run, startedAt: 1_000_000 + RERUN_MATCH_WINDOW_MS + 1 }, [d])).toBeNull();
    expect(matchRerunDispatch({ ...run, startedAt: 1_000_500 }, [d])).toBe(d);
  });
});

describe('the re-run settings', () => {
  test('keep the optional dispatch id input for GitHub', () => {
    expect(
      resolveCiRerunSettings({
        enabled: true,
        github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: ' piwi_dispatch ' },
      }).github,
    ).toEqual({ workflow: 'e2e.yml', ref: 'main', inputName: 'args', dispatchIdInput: 'piwi_dispatch' });
    expect(
      resolveCiRerunSettings({ enabled: true, github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' } }).github,
    ).toEqual({ workflow: 'e2e.yml', ref: 'main', inputName: 'args' });
  });
});

describe('the Flake Lab target', () => {
  test('is kept when complete, dropped when empty', () => {
    expect(
      resolveCiRerunSettings({
        enabled: true,
        flakeLab: {
          github: { workflow: ' flake.yml ', inputName: 'piwi_flake' },
          gitlab: { variableName: '' },
          bitbucket: { pipeline: 'flake', variableName: '' },
        },
      }).flakeLab,
    ).toEqual({ github: { workflow: 'flake.yml', inputName: 'piwi_flake' } });
    expect(
      resolveCiRerunSettings({ enabled: true, flakeLab: { gitlab: { variableName: ' ' } } }).flakeLab,
    ).toBeUndefined();
  });

  test('takes the place of the provider target, on its ref', () => {
    const settings = resolveCiRerunSettings({
      enabled: true,
      github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
      flakeLab: {
        github: { workflow: 'flake.yml', inputName: 'piwi_flake' },
        bitbucket: { pipeline: 'flake', variableName: 'FLAKE_ARGS' },
      },
    });
    expect(flakeLabRerunSettings(settings, 'github')).toEqual({
      enabled: true,
      github: { workflow: 'flake.yml', ref: 'main', inputName: 'piwi_flake' },
    });
    expect(flakeLabRerunSettings(settings, 'bitbucket')).toEqual({
      enabled: true,
      bitbucket: { pipeline: 'flake', variableName: 'FLAKE_ARGS' },
    });
    // GitLab dispatches on the re-run target's ref, which is missing here.
    expect(flakeLabRerunSettings(settings, 'gitlab')).toBeNull();
    expect(flakeLabRerunSettings({ ...settings, enabled: false }, 'github')).toBeNull();
  });

  test('is unavailable until configured, then dispatches the flake command on the test’s branch', async () => {
    await seed(GITHUB);
    dispatched.length = 0;
    expect(await flakeLabCiAvailability(db as never, 1, 1)).toMatchObject({ available: false });
    expect(await runFlakeLabInCi(db as never, 1, 'verify', { id: 1, name: 'Ada' })).toMatchObject({
      ok: false,
      error: 'unavailable',
    });
    expect(dispatched).toHaveLength(0);

    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
          flakeLab: { github: { workflow: 'flake.yml', inputName: 'piwi_flake' } },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect(await flakeLabCiAvailability(db as never, 1, 1)).toEqual({
      available: true,
      reason: null,
      provider: 'github',
    });
    const outcome = await runFlakeLabInCi(db as never, 1, 'verify', { id: 1, name: 'Ada' });
    expect(outcome).toMatchObject({
      ok: true,
      dispatch: { provider: 'github', args: 'flake verify 1', ref: 'feature/coupon', byName: 'Ada' },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args).toBe('flake verify 1');
    expect(dispatched[0]!.request.ref).toBe('feature/coupon');
    expect(dispatched[0]!.settings).toEqual({
      enabled: true,
      github: { workflow: 'flake.yml', ref: 'main', inputName: 'piwi_flake' },
    });
    expect(await runFlakeLabInCi(db as never, 404, 'reproduce', { id: 1, name: 'Ada' })).toMatchObject({
      error: 'not-found',
    });
  });
});
