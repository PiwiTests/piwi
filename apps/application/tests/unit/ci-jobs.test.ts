import { beforeEach, describe, expect, test, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  provider: 'github' as string,
  files: {} as Record<string, string>,
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
      fetchTree: async (ref: string) => {
        repo.asked.push(['tree', ref]);
        return Object.keys(repo.files);
      },
      fetchFileAtRef: async (path: string, ref: string) => {
        repo.asked.push([path, ref]);
        return path in repo.files ? { path, content: repo.files[path], truncated: false } : null;
      },
    };
  },
}));

const { listCiJobs, listCiJobFields } = await import('../../server/utils/ci-jobs');

const db = {} as never;
const use = { actor: { userId: null, apiKeyId: null } };
let projectId = 0;

beforeEach(() => {
  // Each test reads its own project, so nothing comes from what an earlier one kept.
  projectId++;
  repo.provider = 'github';
  repo.files = {};
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

  test('keeps a listing five minutes, whichever workflow is picked, until a refresh', async () => {
    repo.files = { '.github/workflows/e2e.yml': 'on: workflow_dispatch\n' };
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use);
    repo.asked.length = 0;
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: 'e2e.yml' }, use);
    expect(repo.asked).toEqual([]);
    await listCiJobs(db, projectId, { type: 'github', ref: 'main', workflow: '' }, use, { refresh: true });
    expect(repo.asked).toContainEqual(['tree', 'main']);
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
