import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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
    provider: 'gitlab',
    dispatchRerun: async (settings: unknown, args: string, request: Record<string, unknown>) => {
      dispatched.push({ args, request, settings });
      return { url: 'https://ci.example/runs', ref: request.ref ?? 'main', ...answer };
    },
  }),
}));

const {
  dispatchClusterRerun,
  rerunClusterInCi,
  rerunExecutionInCi,
  matchCiRerunRun,
  runFlakeLabInCi,
  flakeLabCiAvailability,
  ciRerunAvailability,
} = await import('../../server/utils/ci-rerun');
const { matchRerunDispatch, resolveCiRerunSettings, RERUN_CLOCK_SLACK_MS, RERUN_MATCH_WINDOW_MS } =
  await import('#shared/ci-rerun');
const { ciActionsFromLegacy, pickCiAction } = await import('#shared/ci-actions');

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
      gitlab: { ref: 'main', variableName: 'PIWI_RERUN_ARGS' },
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

  test('links the dispatch to the build the run recorded', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    const ci = { provider: 'GitHub Actions', buildUrl: 'https://github.com/acme/shop/actions/runs/77' };
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id }, ci }, [1], at + 60_000);
    expect(await matchCiRerunRun(db as never, 2)).toBe(1);
    expect((await lastDispatch()).url).toBe('https://github.com/acme/shop/actions/runs/77');
  });

  test('keeps the dispatch link when the recorded build URL is not http(s)', async () => {
    await seed(GITHUB);
    await rerunClusterInCi(db as never, 1, { id: null, name: null });
    const { id, at } = await lastDispatch();
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id }, ci: { buildUrl: 'javascript:alert(1)' } }, [1], at);
    expect(await matchCiRerunRun(db as never, 2)).toBe(1);
    expect((await lastDispatch()).url).toBe('https://ci.example/runs');
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

  test("matches a CI server's build number with its branch and files, and its branch, time and files without one", () => {
    const numbered = {
      ...base,
      provider: 'ci-server' as const,
      id: 'x',
      at: 0,
      ref: 'main',
      buildNumber: '42',
      files: run.files,
    };
    expect(matchRerunDispatch({ ...run, buildNumber: '42' }, [numbered])).toBe(numbered);
    expect(matchRerunDispatch({ ...run, branch: 'release', buildNumber: '42' }, [numbered])).toBeNull();
    const unnumbered = { ...base, provider: 'ci-server' as const, id: 'y', at: 999_000, ref: 'main', files: run.files };
    expect(matchRerunDispatch(run, [unnumbered])).toBe(unnumbered);
    expect(matchRerunDispatch({ ...run, branch: 'other' }, [unnumbered])).toBeNull();
  });

  test("leaves another job's build of the same number, and a build started before the dispatch", () => {
    const d = {
      ...base,
      provider: 'ci-server' as const,
      id: 'x',
      at: 1_000_000,
      ref: 'main',
      buildNumber: '57',
      files: ['tests/a.spec.ts'],
    };
    const nightly = { ...run, files: ['tests/a.spec.ts', 'tests/b.spec.ts'], buildNumber: '57' };
    expect(matchRerunDispatch(nightly, [d])).toBeNull();
    const early = { ...run, buildNumber: '57', startedAt: 1_000_000 - RERUN_CLOCK_SLACK_MS - 1 };
    expect(matchRerunDispatch(early, [d])).toBeNull();
  });

  test('picks, by its build number, the dispatch a run answers among those of the same branch and files', () => {
    const older = {
      ...base,
      provider: 'ci-server' as const,
      id: 'older',
      at: 900_000,
      ref: 'main',
      buildNumber: '57',
      files: ['tests/a.spec.ts'],
    };
    const newer = { ...older, id: 'newer', at: 950_000, buildNumber: '58' };
    expect(matchRerunDispatch({ ...run, buildNumber: '57' }, [older, newer])).toBe(older);
    expect(matchRerunDispatch({ ...run, buildNumber: null }, [older, newer])).toBe(newer);
    // A CI clock a few seconds behind Piwi's still matches the build.
    expect(matchRerunDispatch({ ...run, buildNumber: '57', startedAt: 895_000 }, [older])).toBe(older);
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

  test('becomes a Flake Lab action on the re-run target’s ref, the default for Flake Lab', () => {
    const settings = ciActionsFromLegacy(
      resolveCiRerunSettings({
        enabled: true,
        github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
        flakeLab: {
          github: { workflow: 'flake.yml', inputName: 'piwi_flake' },
          bitbucket: { pipeline: 'flake', variableName: 'FLAKE_ARGS' },
        },
      }),
    );
    const flake = settings.actions.filter((a) => a.accepts.includes('flakeLab'));
    expect(flake.map((a) => a.target)).toEqual([
      { type: 'github', workflow: 'flake.yml', ref: 'main', argsInput: 'piwi_flake' },
      { type: 'bitbucket', pipeline: 'flake', argsVariable: 'FLAKE_ARGS' },
    ]);
    expect(settings.defaults.flakeLab).toBe(flake[0]!.id);
    expect(pickCiAction(settings, 'flakeLab', { provider: 'github' }).action?.id).toBe(flake[0]!.id);
    expect(pickCiAction(settings, 'flakeLab', { provider: 'bitbucket' }).action?.id).toBe(flake[1]!.id);
    // GitLab has no Flake Lab target here.
    expect(pickCiAction(settings, 'flakeLab', { provider: 'gitlab' }).action).toBeNull();
    expect(pickCiAction({ ...settings, actions: [] }, 'flakeLab', { provider: 'github' }).action).toBeNull();
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
      action: { id: 'flakelab-github', name: 'Flake Lab' },
    });
    const outcome = await runFlakeLabInCi(db as never, 1, 'verify', { id: 1, name: 'Ada' });
    expect(outcome).toMatchObject({
      ok: true,
      dispatch: { provider: 'github', args: 'flake verify 1', ref: 'feature/coupon', byName: 'Ada' },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.args).toBe('flake verify 1');
    expect(dispatched[0]!.request.ref).toBe('feature/coupon');
    expect(dispatched[0]!.settings).toMatchObject({
      type: 'github',
      workflow: 'flake.yml',
      ref: 'main',
      argsInput: 'piwi_flake',
    });
    expect(await runFlakeLabInCi(db as never, 404, 'reproduce', { id: 1, name: 'Ada' })).toMatchObject({
      error: 'not-found',
    });
  });
});

describe('a CI server dispatch', () => {
  let server: Server;
  let base: string;
  let status = 201;
  const received: Array<{ method: string; url: string; authorization?: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
        res.writeHead(status, { Location: `${base}queue/item/5/`, 'Content-Type': 'application/json' });
        res.end(status === 201 ? '' : '{"message":"No such job"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    received.length = 0;
    status = 201;
    process.env.PIWI_CI_SERVER_URL = base;
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'instance-secret';
  });

  afterEach(() => {
    delete process.env.PIWI_CI_SERVER_URL;
    delete process.env.PIWI_CI_SERVER_USER;
    delete process.env.PIWI_CI_SERVER_TOKEN;
  });

  async function useCiServer(ciServer: Record<string, unknown> | null, enabled = true) {
    await db
      .update(schema.projects)
      .set({ ciRerun: { enabled, via: 'ci-server', ...(ciServer ? { ciServer } : {}) } })
      .where(eq(schema.projects.id, 1));
  }

  test('is available without an SCM repository target, and names what is missing', async () => {
    await seed(GITHUB);
    await useCiServer(null);
    expect(await ciRerunAvailability(db as never, 1, 1)).toMatchObject({
      available: false,
      reason: 'No CI action re-runs tests for this project.',
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'polaris/e2e' } }, false);
    expect(await ciRerunAvailability(db as never, 1, 1)).toMatchObject({
      available: false,
      reason: 'CI re-run is off for this project.',
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'polaris/e2e' } });
    expect(await ciRerunAvailability(db as never, 1, 1)).toEqual({
      available: true,
      reason: null,
      provider: 'ci-server',
      enabled: true,
      hasToken: true,
      action: { id: 'rerun-ci-server', name: 'Re-run failed tests' },
    });
    delete process.env.PIWI_CI_SERVER_URL;
    expect(await ciRerunAvailability(db as never, 1, 1)).toMatchObject({
      available: false,
      reason: 'No CI server is configured for this project.',
    });
  });

  test('is unavailable when the branch job has no branch to name', async () => {
    await seed(GITHUB);
    await db
      .update(schema.testRuns)
      .set({ branch: null, metadata: { scm: { remoteUrl: GITHUB }, piwiOrigin: { kind: 'ci' } } })
      .where(eq(schema.testRuns.id, 1));
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e/{branch}' } });
    expect((await ciRerunAvailability(db as never, 1, 1)).reason).toBe('The path placeholder {{branchJob}} is empty');
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e/{branch}', ref: 'main' } });
    expect((await ciRerunAvailability(db as never, 1, 1)).available).toBe(true);
  });

  test('refuses an http base URL on a host nobody listed', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', baseUrl: 'http://jenkins.example.com/', rerun: { job: 'e2e' } });
    expect((await ciRerunAvailability(db as never, 1, 1)).reason).toContain('https');
  });

  test('sends the Jenkins request with the instance credential, and records it', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'polaris/e2e' } });
    const outcome = await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' });
    expect(outcome.ok).toBe(true);
    expect(dispatched).toHaveLength(0);
    expect(received).toHaveLength(1);
    const record = await lastDispatch();
    expect(received[0]).toMatchObject({
      method: 'POST',
      url: '/job/polaris/job/e2e/buildWithParameters',
      authorization: `Basic ${Buffer.from('piwi-bot:instance-secret').toString('base64')}`,
    });
    const form = new URLSearchParams(received[0]!.body);
    expect(form.get('PIWI_RERUN_ARGS')).toBe(
      '"tests/checkout.spec.ts:30" "tests/checkout.spec.ts:12" --project="chromium"',
    );
    expect(form.get('PIWI_ORIGIN_REF')).toBe(record.id);
    expect(record).toMatchObject({
      provider: 'ci-server',
      preset: 'jenkins',
      url: `${base}job/polaris/job/e2e/`,
      ref: 'feature/coupon',
      files: ['tests/checkout.spec.ts'],
      tests: 2,
      byName: 'Ada',
    });
  });

  /** An action with a fixed and a choice input on a Jenkins job, the default for re-runs. */
  async function useStagingAction(extra: Record<string, unknown> = {}) {
    await db
      .update(schema.projects)
      .set({
        ...extra,
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'staging',
              name: 'Staging',
              target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' } },
              inputs: [
                { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
                { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'full' },
              ],
              accepts: ['tests'],
            },
          ],
          defaults: { rerun: 'staging' },
        },
      })
      .where(eq(schema.projects.id, 1));
  }

  test('sends no input on the instance credential unless the operator listed it, and records the action', async () => {
    await seed(GITHUB);
    await useStagingAction();
    expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    expect(received[0]!.authorization).toBe(`Basic ${Buffer.from('piwi-bot:instance-secret').toString('base64')}`);
    const form = new URLSearchParams(received[0]!.body);
    expect(form.has('TARGET_ENV')).toBe(false);
    expect(form.has('SUITE')).toBe(false);
    expect(form.get('PIWI_RERUN_ARGS')).toContain('tests/checkout.spec.ts');
    expect(form.get('PIWI_ORIGIN_REF')).toBeTruthy();
    expect(await lastDispatch()).toMatchObject({ actionId: 'staging', provider: 'ci-server' });
  });

  test('sends the inputs PIWI_CI_SERVER_ALLOWED_INPUTS lists on the instance credential, and no others', async () => {
    await seed(GITHUB);
    await useStagingAction();
    process.env.PIWI_CI_SERVER_ALLOWED_INPUTS = ' TARGET_ENV , OTHER ';
    try {
      expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    } finally {
      delete process.env.PIWI_CI_SERVER_ALLOWED_INPUTS;
    }
    const form = new URLSearchParams(received[0]!.body);
    expect(form.get('TARGET_ENV')).toBe('staging');
    expect(form.has('SUITE')).toBe(false);
    expect(form.get('PIWI_RERUN_ARGS')).not.toContain('staging');
  });

  test('sends every input on the project’s own token', async () => {
    await seed(GITHUB);
    process.env.PIWI_SECRET_KEY = 'a-test-key-for-the-ci-server-token';
    try {
      const { sealCiServerToken } = await import('../../server/utils/ci-server-dispatch');
      await useStagingAction({ ciServerToken: sealCiServerToken(base, 'project-secret') });
      expect((await rerunClusterInCi(db as never, 1, { id: 7, name: 'Ada' })).ok).toBe(true);
    } finally {
      delete process.env.PIWI_SECRET_KEY;
    }
    expect(received[0]!.authorization).toBe(`Basic ${Buffer.from(':project-secret').toString('base64')}`);
    const form = new URLSearchParams(received[0]!.body);
    expect(form.get('TARGET_ENV')).toBe('staging');
    expect(form.get('SUITE')).toBe('full');
  });

  test('picks the action of the run’s environment', async () => {
    await seed(GITHUB);
    const action = (id: string, job: string, environment?: string) => ({
      id,
      name: id,
      target: { type: 'ci-server', preset: 'jenkins', fields: { job } },
      inputs: [],
      accepts: ['tests'],
      ...(environment ? { environment } : {}),
    });
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [action('main', 'main-job'), action('staging', 'staging-job', 'staging')],
          defaults: { rerun: 'main' },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect((await ciRerunAvailability(db as never, 1, 1)).action).toEqual({ id: 'main', name: 'main' });
    await db.update(schema.testRuns).set({ environment: 'staging' }).where(eq(schema.testRuns.id, 1));
    expect((await ciRerunAvailability(db as never, 1, 1)).action).toEqual({ id: 'staging', name: 'staging' });
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(received[0]!.url).toBe('/job/staging-job/buildWithParameters');
  });

  test('sends the action the caller names instead of the default', async () => {
    await seed(GITHUB);
    const action = (id: string, job: string) => ({
      id,
      name: id,
      target: { type: 'ci-server', preset: 'jenkins', fields: { job } },
      inputs: [],
      accepts: ['tests'],
    });
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          actions: [action('main', 'main-job'), action('nightly', 'nightly-job')],
          defaults: { rerun: 'main' },
        },
      })
      .where(eq(schema.projects.id, 1));
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null }, { actionId: 'nightly' })).ok).toBe(true);
    expect(received[0]!.url).toBe('/job/nightly-job/buildWithParameters');
    expect(await rerunClusterInCi(db as never, 1, { id: null, name: null }, { actionId: 'missing' })).toMatchObject({
      ok: false,
      error: 'unavailable',
    });
  });

  test('sends no instance credential to a base URL a project set elsewhere', async () => {
    await seed(GITHUB);
    const other = base.replace('127.0.0.1', 'localhost');
    process.env.PIWI_CI_SERVER_HOSTS = 'localhost';
    await useCiServer({ preset: 'jenkins', baseUrl: other, rerun: { job: 'e2e' } });
    expect((await ciRerunAvailability(db as never, 1, 1)).hasToken).toBe(false);
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(received[0]!.authorization).toBeUndefined();
    delete process.env.PIWI_CI_SERVER_HOSTS;
  });

  test("fails with the server's status and message", async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' } });
    status = 404;
    expect(await rerunClusterInCi(db as never, 1, { id: null, name: null })).toEqual({
      ok: false,
      error: 'dispatch-failed',
      message: 'The CI server answered 404: No such job',
    });
  });

  test('re-runs one execution, and the run it starts is matched and linked to its build', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' } });
    const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testCaseId, 1));
    expect((await rerunExecutionInCi(db as never, execution!.id, { id: null, name: null })).ok).toBe(true);
    expect(new URLSearchParams(received[0]!.body).get('PIWI_RERUN_ARGS')).toBe(
      '"tests/checkout.spec.ts:12" --project="chromium"',
    );
    const { id, at } = await lastDispatch();
    const ci = { provider: 'Jenkins', buildNumber: '88', buildUrl: `${base}job/e2e/88/` };
    await finishedRun(2, { piwiOrigin: { kind: 'ci', ref: id }, ci }, [1], at + 60_000);
    expect(await matchCiRerunRun(db as never, 2)).toBe(1);
    expect(await lastDispatch()).toMatchObject({ runId: 2, url: `${base}job/e2e/88/` });
  });

  test('runs Flake Lab on its own job', async () => {
    await seed(GITHUB);
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' } });
    expect(await flakeLabCiAvailability(db as never, 1, 1)).toMatchObject({
      available: false,
      reason: 'No CI action runs Flake Lab for this project.',
      action: null,
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' }, flakeLab: { job: 'flake-lab' } });
    const outcome = await runFlakeLabInCi(db as never, 1, 'reproduce', { id: 1, name: 'Ada' });
    expect(outcome).toMatchObject({ ok: true, dispatch: { provider: 'ci-server', args: 'flake 1' } });
    expect(received[0]!.url).toBe('/job/flake-lab/buildWithParameters');
    expect(new URLSearchParams(received[0]!.body).get('PIWI_RERUN_ARGS')).toBe('flake 1');
  });
});

describe('an action input a repository host reserves', () => {
  const action = (inputs: Array<Record<string, unknown>>, type: 'gitlab' | 'github') => ({
    id: 'reserved',
    name: 'Reserved',
    target:
      type === 'gitlab'
        ? { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' }
        : { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
    inputs,
    accepts: ['tests'],
  });
  const use = (inputs: Array<Record<string, unknown>>, type: 'gitlab' | 'github') =>
    db
      .update(schema.projects)
      .set({ ciRerun: { enabled: true, actions: [action(inputs, type)], defaults: { rerun: 'reserved' } } })
      .where(eq(schema.projects.id, 1));

  test('is refused at dispatch and reported as unavailable, and nothing is sent', async () => {
    await seed(GITLAB);
    await use([{ name: 'CI_JOB_TOKEN', kind: 'fixed', value: 'x' }], 'gitlab');
    const availability = await ciRerunAvailability(db as never, 1, 1);
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('CI_JOB_TOKEN');
    expect(await rerunClusterInCi(db as never, 1, { id: null, name: null })).toMatchObject({
      ok: false,
      error: 'unavailable',
    });
    expect(dispatched).toHaveLength(0);
  });

  test('is refused by the dispatch itself, which sends nothing, whoever calls it', async () => {
    await seed(GITLAB);
    await use([{ name: 'bitbucket_branch', kind: 'fixed', value: 'x' }], 'gitlab');
    await expect(dispatchClusterRerun(db as never, { id: 1, projectId: 1, lastSeenRunId: 1 })).rejects.toThrow(
      /bitbucket_branch/,
    );
    expect(dispatched).toHaveLength(0);
  });

  test('is refused whatever its case, and a name that merely contains the prefix is sent', async () => {
    await seed(GITLAB);
    await use([{ name: 'gitlab_user_login', kind: 'fixed', value: 'x' }], 'gitlab');
    expect((await ciRerunAvailability(db as never, 1, 1)).available).toBe(false);
    await use([{ name: 'MY_CI_NAME', kind: 'fixed', value: 'x' }], 'gitlab');
    expect((await rerunClusterInCi(db as never, 1, { id: null, name: null })).ok).toBe(true);
    expect(dispatched[0]!.request.inputs).toEqual({ MY_CI_NAME: 'x' });
  });

  test('is allowed on GitHub, which reserves no names', async () => {
    await seed(GITHUB);
    await use([{ name: 'CI_ENV', kind: 'fixed', value: 'x' }], 'github');
    expect((await ciRerunAvailability(db as never, 1, 1)).available).toBe(true);
  });
});
