import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { demoCiBranches, demoCiOffered, demoDispatchCi, demoQueryRecord } = await import('~~/app/demo/api/ci-rerun');
const { parseCiDispatchSource } = await import('#shared/ci-dispatch-request');
const { handleDemoRequest } = await import('~~/app/demo/api/router');
const { loadRerunInfo, rerunInfoFromOffered } = await import('~/composables/useCiRerun');
const { ciTagsArgs } = await import('#shared/ci-tags');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const jenkins = (id: string, name: string, job: string, accepts: string[]) => ({
  id,
  name,
  target: {
    type: 'ci-server',
    preset: 'jenkins',
    baseUrl: 'https://jenkins.example.com/',
    fields: { job, ref: 'main' },
  },
  inputs: [{ name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'full' }],
  accepts,
});

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  await db.insert(schema.users).values({ id: 1, username: 'avery', name: 'Avery', password: '', role: 'admin' });
  await db.insert(schema.projects).values({
    id: 1,
    name: 'shop',
    ciRerun: {
      enabled: true,
      actions: [
        jenkins('rerun', 'Re-run failed tests', 'checkout', ['tests', 'suite', 'tags']),
        jenkins('branches', 'Branch jobs', 'checkout/{branch}', ['suite', 'tags']),
        {
          id: 'gh',
          name: 'GitHub',
          target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
          inputs: [],
          accepts: ['tests', 'flakeLab'],
        },
      ],
      defaults: { rerun: 'rerun', suite: 'rerun' },
    },
  });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    branch: 'main',
    startTime: new Date('2026-09-01T10:00:00Z'),
    metadata: { ci: { provider: 'Jenkins' } },
    origin: 'ci',
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
  await db
    .insert(schema.testRunsCases)
    .values({ testRunId: 1, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium', failureClusterId: 1 });
});

const request = (source: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ source, action: null, ref: null, inputs: null, ...extra }) as Parameters<typeof demoDispatchCi>[2];

describe('the demo’s CI dispatch', () => {
  test('stores the dispatch as the server does, and the cluster’s offered actions read it as its last', async () => {
    const sent = await demoDispatchCi(db as never, 1, request({ from: 'cluster', clusterId: 1 }), 1);
    expect(sent).toMatchObject({
      actionId: 'rerun',
      actionName: 'Re-run failed tests',
      kind: 'tests',
      origin: 'page',
      provider: 'ci-server',
      preset: 'jenkins',
      ref: null,
      args: '"/tests/checkout.spec.ts:12" --project="chromium"',
      state: 'dispatched',
      byName: 'Avery',
      url: 'https://jenkins.example.com/job/checkout/',
    });
    expect((await demoCiOffered(db as never, 1, { from: 'cluster', clusterId: 1 }, 1)).lastDispatch?.id).toBe(sent.id);
  });

  test('answers a repeat within ten seconds with 409 and the first dispatch, as the server does', async () => {
    const first = await demoDispatchCi(db as never, 1, request({ from: 'cluster', clusterId: 1 }), 1);
    const repeat = await demoDispatchCi(db as never, 1, request({ from: 'cluster', clusterId: 1 }), 1).catch(
      (e: unknown) => e,
    );
    expect(repeat).toMatchObject({ statusCode: 409, data: { dispatch: { id: first.id } } });
    expect(await db.select().from(schema.ciDispatches)).toHaveLength(1);
  });

  test('sends a whole suite on the branch and with the choice asked, and refuses what the server refuses', async () => {
    const suite = await demoDispatchCi(
      db as never,
      1,
      request({ from: 'project' }, { action: 'branches', ref: 'release/2.0', inputs: { SUITE: 'smoke' } }),
      1,
    );
    expect(suite).toMatchObject({ kind: 'suite', ref: 'release/2.0', args: '' });
    const [row] = await db.select().from(schema.ciDispatches).where(eq(schema.ciDispatches.id, suite.id));
    expect(row!.inputs).toEqual({ SUITE: 'smoke' });
    const refused = (extra: Record<string, unknown>, source: Record<string, unknown> = { from: 'project' }) =>
      demoDispatchCi(db as never, 1, request(source, extra), 1).catch((e: { statusCode: number; message: string }) => ({
        statusCode: e.statusCode,
        message: e.message,
      }));
    expect(await refused({ ref: 'main' })).toMatchObject({ statusCode: 400, message: /configured branch/ });
    expect(await refused({ inputs: { SUITE: 'nightly' } })).toMatchObject({ statusCode: 400 });
    expect(await refused({ action: 'nope' })).toMatchObject({ statusCode: 404 });
    expect(await refused({}, { from: 'cluster', clusterId: 9 })).toMatchObject({ statusCode: 404 });
    expect(await refused({ action: 'gh' }, { from: 'cluster', clusterId: 1 })).toEqual({
      statusCode: 400,
      message: 'The demo has no repository to dispatch to: it runs only CI server actions.',
    });
  });

  test('sends the project’s tagged tests as one --grep, on its default branch to a job that takes one, and refuses no tag, as the server does', async () => {
    const tagged = await demoDispatchCi(
      db as never,
      1,
      request({ from: 'tags', tags: ['smoke', 'checkout'], match: 'any' }),
      1,
    );
    expect(tagged).toMatchObject({
      kind: 'tags',
      actionId: 'rerun',
      args: ciTagsArgs(['smoke', 'checkout'], 'any'),
      ref: null,
      tests: null,
      state: 'dispatched',
    });
    const [row] = await db.select().from(schema.ciDispatches).where(eq(schema.ciDispatches.id, tagged.id));
    expect(row).toMatchObject({ sourceRunId: null, clusterId: null, files: null, tests: null });
    // A job that names the branch runs the project's, its runs' most common one here, or the one asked.
    const onBranch = (ref: string | null) =>
      demoDispatchCi(
        db as never,
        1,
        request({ from: 'tags', tags: ['slow'], match: 'any' }, { action: 'branches', ref }),
        1,
      );
    expect(await onBranch(null)).toMatchObject({ actionId: 'branches', ref: 'main' });
    expect(await onBranch('release/2.0')).toMatchObject({ actionId: 'branches', ref: 'release/2.0' });
    await expect(
      demoDispatchCi(db as never, 1, request({ from: 'tags', tags: [], match: 'any' }), 1),
    ).rejects.toMatchObject({ statusCode: 400, message: 'A dispatch of tagged tests names at least one tag.' });
    await expect(
      demoDispatchCi(db as never, 1, request({ from: 'tags', tags: ['smoke'], match: 'any' }, { action: 'gh' }), 1),
    ).rejects.toMatchObject({ statusCode: 400, message: 'The CI action "GitHub" does not accept Tagged tests.' });
    // Through the router: the offered actions before a tag is picked, and the tags of a query given one key each.
    expect(await handleDemoRequest('/api/projects/1/ci-actions/offered', 'GET', undefined, 'tags=')).toMatchObject({
      kind: 'tags',
      defaultActionId: 'rerun',
      actions: [
        { id: 'rerun', available: true },
        { id: 'branches', available: true },
      ],
    });
    expect(parseCiDispatchSource(demoQueryRecord(new URLSearchParams('tags=smoke&tags=checkout&match=all')))).toEqual({
      ok: true,
      value: { from: 'tags', tags: ['smoke', 'checkout'], match: 'all' },
    });
    expect(demoQueryRecord(new URLSearchParams('tags=smoke&clusterId=3'))).toEqual({ tags: 'smoke', clusterId: '3' });
    await expect(
      handleDemoRequest('/api/projects/1/ci-actions/offered', 'GET', undefined, 'tags=%24x&tags=smoke'),
    ).rejects.toMatchObject({ statusCode: 400, message: /cannot be sent to CI/ });
    expect(
      await handleDemoRequest('/api/projects/1/ci-dispatches', 'POST', {
        source: { tags: ['@flaky'], match: 'all' },
        kind: 'tags',
      }),
    ).toMatchObject({ kind: 'tags', args: ciTagsArgs(['flaky'], 'any') });
  });

  test('offers each action with why the demo cannot send a repository host’s', async () => {
    const offered = await demoCiOffered(db as never, 1, { from: 'cluster', clusterId: 1 }, 1);
    expect(offered).toMatchObject({ enabled: true, kind: 'tests', defaultActionId: 'rerun' });
    expect(offered.actions.map((a) => [a.id, a.available, a.reason, a.branch])).toEqual([
      ['rerun', true, null, { mode: 'fixed', default: null }],
      [
        'gh',
        false,
        'The demo has no repository to dispatch to: it runs only CI server actions.',
        { mode: 'list', default: 'main' },
      ],
    ]);
    const lab = await demoCiOffered(db as never, 1, { from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' }, 1);
    expect(lab).toMatchObject({ kind: 'flakeLab', defaultActionId: null, lastDispatch: null });
    expect(rerunInfoFromOffered(offered)).toEqual({
      available: true,
      reason: null,
      action: { id: 'rerun', name: 'Re-run failed tests' },
      lastDispatch: null,
    });
    expect(rerunInfoFromOffered(lab)).toEqual({ available: false, reason: null, action: null, lastDispatch: null });
  });

  test('lists the run branches of an action, and serves every route through the router', async () => {
    expect(await demoCiBranches(db as never, 1, 'branches', null)).toEqual({
      items: [{ name: 'main', source: 'runs' }],
    });
    await expect(demoCiBranches(db as never, 1, 'nope', null)).rejects.toMatchObject({ statusCode: 404 });
    const sent = (await handleDemoRequest('/api/projects/1/ci-dispatches', 'POST', { source: { clusterId: 1 } })) as {
      id: string;
    };
    expect(await handleDemoRequest(`/api/ci-dispatches/${sent.id}`)).toMatchObject({ id: sent.id, kind: 'tests' });
    expect(await handleDemoRequest('/api/projects/1/ci-dispatches', 'GET', undefined, 'state=open')).toMatchObject({
      items: [{ id: sent.id }],
    });
    expect(
      await handleDemoRequest('/api/projects/1/ci-actions/offered', 'GET', undefined, 'clusterId=1'),
    ).toMatchObject({ lastDispatch: { id: sent.id } });
    await expect(handleDemoRequest('/api/ci-dispatches/ffffffffffffffff')).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      handleDemoRequest('/api/projects/1/ci-dispatches', 'POST', { source: { runId: 1 }, kind: 'tests' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('loadRerunInfo', () => {
  /** `$fetch` as the demo's service worker answers it. */
  const fetcher = (async (url: string, options?: { query?: Record<string, unknown> }) =>
    handleDemoRequest(
      url,
      'GET',
      undefined,
      new URLSearchParams(Object.entries(options?.query ?? {}).map(([k, v]) => [k, String(v)])).toString(),
    )) as unknown as typeof $fetch;
  const place = { projectId: 1, source: { clusterId: 1 }, clusterId: 1 };

  test('gives a viewer the cluster’s last dispatch the provider took, and one who may dispatch what it is offered', async () => {
    const sent = await demoDispatchCi(db as never, 1, request({ from: 'cluster', clusterId: 1 }), 1);
    // A later refusal is not the last re-run.
    await db.insert(schema.ciDispatches).values({
      id: 'ffffffffffffffff',
      projectId: 1,
      actionId: 'rerun',
      actionName: 'Re-run failed tests',
      origin: 'page',
      kind: 'tests',
      provider: 'ci-server',
      args: 'x',
      inputs: {},
      clusterId: 1,
      state: 'refused',
      detail: 'No such job',
      createdAt: new Date(Date.now() + 60_000),
    });
    expect(await loadRerunInfo(fetcher, { ...place, mayDispatch: false })).toEqual({
      available: false,
      reason: null,
      action: null,
      lastDispatch: expect.objectContaining({ id: sent.id }),
    });
    expect(await loadRerunInfo(fetcher, { ...place, mayDispatch: true })).toMatchObject({
      available: true,
      action: { id: 'rerun' },
      lastDispatch: { id: sent.id },
    });
    const noCluster = { projectId: 1, source: { executionId: 1, scope: 'test' as const }, clusterId: null };
    expect(await loadRerunInfo(fetcher, { ...noCluster, mayDispatch: false })).toMatchObject({ lastDispatch: null });
  });
});

describe('the CI action editor’s listings in the demo', () => {
  const jenkinsTarget = (job = '') => ({
    type: 'ci-server',
    preset: 'jenkins',
    baseUrl: 'https://jenkins.example.com/',
    fields: { job, ref: 'main' },
  });

  test('lists the Jenkins jobs and a job’s parameters, through the server’s readers', async () => {
    const listing = await handleDemoRequest('/api/projects/1/ci-actions/jobs', 'POST', { target: jenkinsTarget() });
    expect(listing).toMatchObject({ truncated: false, message: null });
    expect((listing as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toContain('api/nightly');
    const fields = await handleDemoRequest('/api/projects/1/ci-actions/fields', 'POST', {
      target: jenkinsTarget('api/nightly'),
    });
    expect((fields as { fields: Array<{ name: string }> }).fields.map((f) => f.name)).toEqual([
      'PIWI_RERUN_ARGS',
      'PIWI_ORIGIN_REF',
      'TEST_SUITE',
      'HEADED',
    ]);
  });

  test('has no repository to read, and refuses what names nothing to read', async () => {
    expect(
      await handleDemoRequest('/api/projects/1/ci-actions/jobs', 'POST', {
        target: { type: 'github', ref: 'main', workflow: '' },
      }),
    ).toMatchObject({ jobs: null, message: expect.stringContaining('no repository') });
    await expect(
      handleDemoRequest('/api/projects/1/ci-actions/jobs', 'POST', { target: { type: 'ci-server', preset: 'custom' } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('refuses a base URL that is not https, as the server does', async () => {
    expect(
      await handleDemoRequest('/api/projects/1/ci-actions/jobs', 'POST', {
        target: { ...jenkinsTarget(), baseUrl: 'http://jenkins.internal/' },
      }),
    ).toMatchObject({ jobs: null, message: expect.stringContaining('https') });
  });
});
