import { beforeEach, describe, expect, test, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  provider: 'github' as string,
  files: {} as Record<string, string>,
  /** Files whose read fails. */
  failing: new Set<string>(),
  /** The commit each branch names now. */
  heads: {} as Record<string, string>,
  asked: [] as string[][],
  options: [] as Array<Record<string, unknown> | undefined>,
}));
vi.mock('../../server/utils/scm/project-repository', () => ({
  readProjectRepositoryUrl: async () => 'https://github.com/acme/shop.git',
}));
vi.mock('../../server/utils/scm', () => ({
  createScmProvider: async (_url: string, _db: unknown, _projectId: number, options?: Record<string, unknown>) => {
    repo.options.push(options);
    if (options?.credentialId === 99) {
      const { CredentialRefusedError } = await import('../../server/utils/credentials');
      throw new CredentialRefusedError('The credential "Dispatch only" is disabled.');
    }
    return {
      provider: repo.provider,
      getDefaultBranch: async () => 'trunk',
      getBranchHead: async (branch: string) => repo.heads[branch] ?? null,
      fetchTree: async (ref: string) => {
        repo.asked.push(['tree', ref]);
        return Object.keys(repo.files);
      },
      fetchFileAtRef: async (path: string, ref: string) => {
        repo.asked.push([path, ref]);
        if (repo.failing.has(path)) throw new Error('GitHub answered 403: rate limit exceeded');
        return path in repo.files ? { path, content: repo.files[path], truncated: false } : null;
      },
    };
  },
}));

const { listCiJobs, listCiJobFields, resolveCiListingRequest } = await import('../../server/utils/ci-jobs');
const { checkCiAction } = await import('../../server/utils/ci-actions');
const { openTempDb } = await import('./temp-db');

const db = {} as never;
const use = { actor: { userId: null, apiKeyId: null } };
let projectId = 0;

beforeEach(() => {
  // Each test reads its own project, so nothing comes from what an earlier one kept.
  projectId++;
  repo.provider = 'github';
  repo.files = {};
  repo.failing.clear();
  repo.heads = {};
  repo.asked.length = 0;
});

describe('GitHub', () => {
  test('lists the workflows a dispatch can start, by their name, at the target’s ref', async () => {
    repo.files = {
      '.github/workflows/e2e.yml': 'name: E2E\non:\n  workflow_dispatch:\n    inputs:\n      args: {}\n',
      '.github/workflows/lint.yml': 'on: push\n',
      '.github/workflows/nightly.yaml': 'on: [schedule, workflow_dispatch]\n',
      '.github/workflows/nested/x.yml': 'on: workflow_dispatch\n',
      'README.md': '',
    };
    const listing = await listCiJobs(db, projectId, { type: 'github', ref: 'release', workflow: '' }, use);
    expect(listing).toEqual({
      jobs: [
        { id: 'e2e.yml', label: 'E2E', description: 'e2e.yml' },
        { id: 'nightly.yaml', label: 'nightly.yaml' },
      ],
      truncated: false,
      message: null,
    });
    expect(repo.asked).toContainEqual(['tree', 'release']);
    expect(repo.asked).toContainEqual(['.github/workflows/e2e.yml', 'release']);
  });

  test('keeps a listing whichever workflow is picked, until a refresh', async () => {
    repo.files = { '.github/workflows/e2e.yml': 'on: workflow_dispatch\n' };
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    repo.asked.length = 0;
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: 'e2e.yml' }, use);
    expect(repo.asked).toEqual([]);
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use, { refresh: true });
    expect(repo.asked).toContainEqual(['tree', 'main']);
  });

  test('reads a branch at the commit it names now, so a push is read at once', async () => {
    repo.heads = { main: 'c0ffee1' };
    repo.files = { '.github/workflows/e2e.yml': 'on: workflow_dispatch\n' };
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    expect(repo.asked).toContainEqual(['tree', 'c0ffee1']);
    expect(repo.asked).toContainEqual(['.github/workflows/e2e.yml', 'c0ffee1']);
    repo.asked.length = 0;
    await listCiJobFields(db, projectId, { type: 'github', ref: 'main', workflow: 'e2e.yml' }, use);
    expect(repo.asked).toEqual([['.github/workflows/e2e.yml', 'c0ffee1']]);
  });

  test('names the workflow files it could not read, and keeps no list that may lack one', async () => {
    repo.files = {
      '.github/workflows/e2e.yml': 'on: workflow_dispatch\n',
      '.github/workflows/nightly.yml': 'on: workflow_dispatch\n',
    };
    repo.failing.add('.github/workflows/nightly.yml');
    const listing = await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    expect(listing).toEqual({
      jobs: [{ id: 'e2e.yml', label: 'e2e.yml' }],
      truncated: false,
      message: 'nightly.yml could not be read, so the list may lack a workflow.',
    });
    repo.asked.length = 0;
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    expect(repo.asked).toContainEqual(['tree', 'main']);
    repo.failing.add('.github/workflows/e2e.yml');
    expect(
      await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use, { refresh: true }),
    ).toEqual({ jobs: null, truncated: false, message: expect.stringContaining('rate limit exceeded') });
  });

  test('reads the first workflow files only, and says so', async () => {
    for (let i = 0; i < 45; i++) repo.files[`.github/workflows/w${String(i).padStart(2, '0')}.yml`] = 'on: push\n';
    const listing = await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    expect(listing).toMatchObject({ jobs: [], truncated: true, message: expect.stringContaining('first 40') });
    expect(repo.asked.filter(([path]) => path.startsWith('.github/'))).toHaveLength(40);
  });

  test('lists and reads a workflow whose file name holds a space', async () => {
    repo.files = { '.github/workflows/e2e nightly.yml': 'on:\n  workflow_dispatch:\n    inputs:\n      args: {}\n' };
    const listing = await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    expect(listing.jobs).toEqual([{ id: 'e2e nightly.yml', label: 'e2e nightly.yml' }]);
    expect(
      await listCiJobFields(db, projectId, { type: 'github', ref: 'main', workflow: 'e2e nightly.yml' }, use),
    ).toMatchObject({ fields: [{ name: 'args' }] });
  });

  test('says when no workflow can be dispatched', async () => {
    repo.files = { '.github/workflows/lint.yml': 'on: push\n' };
    expect(await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use)).toEqual({
      jobs: [],
      truncated: false,
      message: expect.stringContaining('No workflow at main has a workflow_dispatch trigger'),
    });
  });

  test('reads a workflow’s inputs', async () => {
    repo.files = {
      '.github/workflows/e2e.yml':
        'on:\n  workflow_dispatch:\n    inputs:\n      args: {}\n      env: { type: choice, options: [a, b] }\n',
    };
    expect(await listCiJobFields(db, projectId, { type: 'github', ref: 'main', workflow: 'e2e.yml' }, use)).toEqual({
      fields: [
        { name: 'args', type: 'string', required: false },
        { name: 'env', type: 'choice', required: false, options: ['a', 'b'] },
      ],
      message: null,
    });
  });

  test('says why a workflow’s inputs are not known', async () => {
    const fields = (workflow: string) =>
      listCiJobFields(db, projectId, { type: 'github', ref: 'main', workflow }, use, { refresh: true });
    expect(await fields('')).toEqual({ fields: null, message: 'Pick a workflow first.' });
    expect((await fields('missing.yml')).message).toContain('could not be read at main');
    repo.files = { '.github/workflows/push.yml': 'on: push\n' };
    expect((await fields('push.yml')).message).toContain('no workflow_dispatch trigger');
  });

  test('reads with the credential the target names, and a refusal is its answer', async () => {
    const listing = await listCiJobs(
      db,
      projectId,
      { type: 'github', ref: 'main', workflow: '', credentialId: 99 },
      use,
    );
    expect(listing).toEqual({ jobs: null, truncated: false, message: 'The credential "Dispatch only" is disabled.' });
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '', credentialId: 5 }, use);
    expect(repo.options.at(-1)).toMatchObject({ credentialId: 5, strict: true });
  });

  test('reads nothing from a repository on another host', async () => {
    repo.provider = 'gitlab';
    expect(await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use)).toMatchObject({
      jobs: null,
      message: "This project's repository is not on GitHub, so its workflows can't be read.",
    });
  });
});

describe('GitLab', () => {
  test('reads a CI file that reuses its anchors in every job', async () => {
    repo.provider = 'gitlab';
    let file = '.defaults: &defaults\n  variables:\n    SUITE: smoke\n';
    for (let i = 0; i < 150; i++) file += `job${i}:\n  <<: *defaults\n  script: [x]\n`;
    repo.files = { '.gitlab-ci.yml': file };
    expect(await listCiJobFields(db, projectId, { type: 'gitlab', ref: 'main' }, use)).toMatchObject({
      fields: [{ name: 'SUITE', default: 'smoke' }],
    });
  });

  test('has no job to pick, and suggests the variables its CI file sets', async () => {
    repo.provider = 'gitlab';
    repo.files = {
      '.gitlab-ci.yml': 'include: [{ local: ci/e2e.yml }]\nvariables:\n  SUITE: smoke\n',
    };
    expect(await listCiJobs(db, projectId, { type: 'gitlab', ref: 'main' }, use)).toMatchObject({ jobs: null });
    expect(await listCiJobFields(db, projectId, { type: 'gitlab', ref: 'main' }, use)).toEqual({
      fields: [{ name: 'SUITE', type: 'string', required: false, default: 'smoke' }],
      message: expect.stringContaining('Variables of the files it includes are not listed.'),
    });
  });
});

describe('Bitbucket', () => {
  const PIPELINES =
    'pipelines:\n  custom:\n    rerun:\n      - variables:\n          - name: PIWI_RERUN_ARGS\n      - step: { script: [x] }\n';

  test('lists the custom pipelines and their variables on the default branch', async () => {
    repo.provider = 'bitbucket';
    repo.files = { 'bitbucket-pipelines.yml': PIPELINES };
    expect(await listCiJobs(db, projectId, { type: 'bitbucket', pipeline: '' }, use)).toEqual({
      jobs: [{ id: 'rerun', label: 'rerun' }],
      truncated: false,
      message: null,
    });
    expect(repo.asked).toContainEqual(['bitbucket-pipelines.yml', 'trunk']);
    expect(await listCiJobFields(db, projectId, { type: 'bitbucket', pipeline: 'rerun' }, use)).toEqual({
      fields: [{ name: 'PIWI_RERUN_ARGS', type: 'string', required: false }],
      message: null,
    });
    expect((await listCiJobFields(db, projectId, { type: 'bitbucket', pipeline: 'nightly' }, use)).message).toContain(
      'no custom pipeline named "nightly"',
    );
  });
});

describe('Check on a Bitbucket action', () => {
  const action = (pipeline: string) => ({
    id: 'bb',
    name: 'Re-run on Bitbucket',
    target: { type: 'bitbucket' as const, pipeline, argsVariable: 'PIWI_RERUN_ARGS' },
    inputs: [{ name: 'REGION', kind: 'fixed' as const, value: 'eu' }],
    accepts: ['tests' as const],
  });

  beforeEach(() => {
    repo.provider = 'bitbucket';
  });

  test('passes a custom pipeline that declares every name a dispatch sends, read on the default branch', async () => {
    repo.files = {
      'bitbucket-pipelines.yml':
        'pipelines:\n  custom:\n    rerun:\n      - variables:\n          - name: PIWI_RERUN_ARGS\n          - name: REGION\n      - step: { script: [x] }\n',
    };
    expect(await checkCiAction(db, projectId, action('rerun'), use)).toMatchObject({ ok: true, missing: [] });
    expect(repo.asked).toContainEqual(['bitbucket-pipelines.yml', 'trunk']);
  });

  test('fails a custom pipeline the default branch does not have', async () => {
    repo.files = { 'bitbucket-pipelines.yml': 'pipelines:\n  custom:\n    other: []\n' };
    expect(await checkCiAction(db, projectId, action('rerun'), use)).toMatchObject({
      ok: false,
      message: expect.stringContaining('has no custom pipeline named "rerun"'),
    });
  });

  test('names the variables it does not declare without failing, and says when the pipeline is imported', async () => {
    repo.files = {
      'bitbucket-pipelines.yml':
        'pipelines:\n  custom:\n    rerun:\n      - variables:\n          - name: PIWI_RERUN_ARGS\n    shared:\n      import: lib:main:e2e\n',
    };
    expect(await checkCiAction(db, projectId, action('rerun'), use)).toMatchObject({ ok: null, missing: ['REGION'] });
    expect(await checkCiAction(db, projectId, action('shared'), use)).toMatchObject({
      ok: null,
      missing: [],
      message: expect.stringContaining('imported from another repository'),
    });
  });
});

describe('a listing request', () => {
  test('refuses a credential the project may not name, as a save would', async () => {
    const { db: temp, close } = await openTempDb();
    try {
      const refused = await resolveCiListingRequest(temp as never, 1, {
        target: { type: 'github', ref: 'main', credentialId: 999 },
        name: 'Smoke',
      });
      expect(refused).toEqual({ error: expect.stringContaining('"Smoke": no SCM credential 999') });
      expect(
        await resolveCiListingRequest(temp as never, 1, {
          target: { type: 'github', ref: 'main' },
          actionId: 'a1b2c3d4',
          refresh: true,
        }),
      ).toEqual({ target: { type: 'github', ref: 'main', workflow: '' }, refresh: true, actionId: 'a1b2c3d4' });
    } finally {
      await close();
    }
  });
});
