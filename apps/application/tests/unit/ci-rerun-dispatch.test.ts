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
  rerunClusterInCi,
  rerunExecutionInCi,
  matchCiRerunRun,
  runFlakeLabInCi,
  flakeLabCiAvailability,
  ciRerunAvailability,
} = await import('../../server/utils/ci-rerun');
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

  test("matches a CI server's build number on its branch, and its branch, time and files without one", () => {
    const numbered = { ...base, provider: 'ci-server' as const, id: 'x', at: 0, ref: 'main', buildNumber: '42' };
    expect(matchRerunDispatch({ ...run, files: [], buildNumber: '42' }, [numbered])).toBe(numbered);
    expect(matchRerunDispatch({ ...run, files: [], branch: 'release', buildNumber: '42' }, [numbered])).toBeNull();
    const unnumbered = { ...base, provider: 'ci-server' as const, id: 'y', at: 999_000, ref: 'main', files: run.files };
    expect(matchRerunDispatch(run, [unnumbered])).toBe(unnumbered);
    expect(matchRerunDispatch({ ...run, branch: 'other' }, [unnumbered])).toBeNull();
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
      provider: 'ci-server',
      reason: 'No CI server is configured for this project.',
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
    expect(await flakeLabCiAvailability(db as never, 1, 1)).toEqual({
      available: false,
      reason: 'No Flake Lab request is configured for the CI server.',
      provider: 'ci-server',
    });
    await useCiServer({ preset: 'jenkins', rerun: { job: 'e2e' }, flakeLab: { job: 'flake-lab' } });
    const outcome = await runFlakeLabInCi(db as never, 1, 'reproduce', { id: 1, name: 'Ada' });
    expect(outcome).toMatchObject({ ok: true, dispatch: { provider: 'ci-server', args: 'flake 1' } });
    expect(received[0]!.url).toBe('/job/flake-lab/buildWithParameters');
    expect(new URLSearchParams(received[0]!.body).get('PIWI_RERUN_ARGS')).toBe('flake 1');
  });
});
