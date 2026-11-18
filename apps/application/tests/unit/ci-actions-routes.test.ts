import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Saving CI actions through the server's project route and through the demo router: both answer HTTP 400 for a
 * payload that breaks a limit, for a CI server action whose credential the project may not use there, and for the
 * project CI server token credentials replace, and both leave the stored settings as they were.
 */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));
vi.mock('../../server/utils/project-access', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireProjectAccess: async () => undefined,
}));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Handler = (event: FakeEvent) => Promise<{ project: Record<string, unknown> }>;
const patchProject = (await import('../../server/api/projects/[id].patch')).default as unknown as Handler;
const { handleDemoRequest } = await import('~~/app/demo/api/router');
const { insertCredential } = await import('../../shared/handlers/credentials');
const { listProjects } = await import('../../shared/handlers/projects');

const A = 'https://a.example.com/';
const B = 'https://b.example.com/';

const server = (id: string, target: Record<string, unknown> = {}) => ({
  id,
  name: id,
  target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' }, ...target },
  inputs: [],
  accepts: ['tests'],
});
const custom = (id: string, target: Record<string, unknown> = {}) =>
  server(id, {
    preset: 'custom',
    fields: {},
    custom: { auth: 'bearer', request: { method: 'POST', path: 'build' } },
    ...target,
  });
const github = (over: Record<string, unknown> = {}) => ({
  id: 'smoke',
  name: 'Smoke',
  target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
  inputs: [],
  accepts: ['tests'],
  ...over,
});
const settings = (actions: unknown[]) => ({ enabled: true, actions, defaults: {} });

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
});

afterAll(async () => {
  await close();
});

/** The credentials the actions name: shared with the project, with another one, and the one the environment sets. */
const ids = { shared: 0, sharedCustom: 0, elsewhere: 0, env: 0 };

beforeEach(async () => {
  await db.delete(schema.credentials);
  await db.delete(schema.projects);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  const credential = (name: string, projectIds: number[], customRequests = false) =>
    insertCredential(
      db as never,
      {
        name,
        description: null,
        service: 'ci-server',
        user: 'piwi-bot',
        destination: A,
        scope: { allProjects: false, projectIds },
        allowedInputs: null,
        customRequests,
        disabled: false,
      },
      null,
      null,
    );
  ids.shared = await credential('Shared', [1]);
  ids.sharedCustom = await credential('Shared custom', [1], true);
  ids.elsewhere = await credential('Elsewhere', [2]);
  const [env] = await db
    .insert(schema.credentials)
    .values({
      name: 'CI server (environment)',
      service: 'ci-server',
      destination: A,
      allProjects: true,
      managedBy: 'env',
    })
    .returning({ id: schema.credentials.id });
  ids.env = env!.id;
});

const serverPatch = (body: unknown) => patchProject({ params: { id: '1' }, body });
const demoPatch = (body: unknown) =>
  handleDemoRequest('/api/projects/1', 'PATCH', body) as Promise<{ project: Record<string, unknown> }>;
const routes = [
  ['the server route', serverPatch],
  ['the demo router', demoPatch],
] as const;

const stored = async () => {
  const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, 1));
  return row!;
};

describe.each(routes)('PATCH of CI actions through %s', (_name, patch) => {
  test('answers 400 for a fixed value, an option or an action name over its limit, and stores nothing', async () => {
    const long = 'x'.repeat(501);
    const input = (extra: Record<string, unknown>) => ({ name: 'A', ...extra });
    const bad = [
      [github({ inputs: [input({ kind: 'fixed', value: long })] })],
      [github({ inputs: [input({ kind: 'choice', options: ['a', long] })] })],
      [github({ inputs: [input({ kind: 'choice', options: Array.from({ length: 51 }, (_, i) => `v${i}`) })] })],
      [github({ name: 'n'.repeat(81) })],
      [github(), github({ name: 'Other' })],
      [github({ inputs: [input({ name: '9bad', kind: 'fixed', value: 'x' })] })],
    ];
    for (const actions of bad) {
      await expect(patch({ ciRerun: settings(actions) })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect((await stored()).ciRerun).toBeNull();
  });

  test('answers 400 for a reserved GitLab or Bitbucket variable, whatever its case', async () => {
    const onGitlab = (name: string) => ({
      id: 'gl',
      name: 'GitLab',
      target: { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' },
      inputs: [{ name, kind: 'fixed', value: 'x' }],
      accepts: ['tests'],
    });
    for (const reserved of ['CI_JOB_TOKEN', 'gitlab_user_login', 'Bitbucket_Branch']) {
      await expect(patch({ ciRerun: settings([onGitlab(reserved)]) })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(reserved),
      });
    }
    await expect(patch({ ciRerun: settings([onGitlab('MY_CI_NAME')]) })).resolves.toBeDefined();
  });

  test('answers 400 for a CI server token, which credentials replace, and stores nothing', async () => {
    await expect(patch({ ciServerToken: 'secret' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('credentialId'),
    });
    await expect(
      patch({ ciRerun: settings([server('a', { credentialId: ids.shared })]), ciServerToken: null }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const row = await stored();
    expect(row.ciRerun).toBeNull();
    expect(row.ciServerToken).toBeNull();
  });

  test('answers 400 for a credential that does not exist, is shared with another project or is set by the environment', async () => {
    for (const credentialId of [9999, ids.elsewhere, ids.env]) {
      await expect(patch({ ciRerun: settings([server('a', { credentialId })]) })).rejects.toMatchObject({
        statusCode: 400,
        message: `"a": no CI server credential ${credentialId} is shared with this project.`,
      });
    }
    expect((await stored()).ciRerun).toBeNull();
  });

  test('answers 400 for a base URL outside the credential’s destination, and a Custom request it does not allow', async () => {
    await expect(
      patch({ ciRerun: settings([server('a', { credentialId: ids.shared, baseUrl: B })]) }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(`is not under ${A}`) });
    await expect(patch({ ciRerun: settings([custom('c', { credentialId: ids.shared })]) })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('does not go with a Custom request'),
    });
    await expect(
      patch({ ciRerun: settings([custom('c', { credentialId: ids.sharedCustom })]) }),
    ).resolves.toBeDefined();
  });

  test('saves an action that names a credential shared with the project, under its destination', async () => {
    await patch({
      ciRerun: settings([
        server('a', { credentialId: ids.shared }),
        server('b', { credentialId: ids.shared, baseUrl: `${A}job/qa/` }),
      ]),
    });
    const actions = (await stored()).ciRerun as { actions: Array<{ target: Record<string, unknown> }> };
    expect(actions.actions.map((a) => a.target)).toEqual([
      expect.objectContaining({ credentialId: ids.shared }),
      expect.objectContaining({ credentialId: ids.shared, baseUrl: `${A}job/qa/` }),
    ]);
    expect(actions.actions[0]!.target).not.toHaveProperty('baseUrl');
  });

  test('keeps an action without a credential, which the instance’s serves', async () => {
    await expect(patch({ ciRerun: settings([server('a'), server('b', { baseUrl: B })]) })).resolves.toBeDefined();
  });

  test('names one of the project’s environments by id, an archived one only when the action named it already', async () => {
    await db.delete(schema.environments);
    const [staging, archived, foreign] = await db
      .insert(schema.environments)
      .values([
        { projectId: 1, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['stg'], position: 0 },
        { projectId: 1, key: 'old', keyFold: 'old', name: 'Old', position: 1, archivedAt: new Date() },
        { projectId: 2, key: 'prod', keyFold: 'prod', name: 'Production', position: 0 },
      ])
      .returning({ id: schema.environments.id });
    const actions = async () =>
      ((await stored()).ciRerun as { actions: Array<{ environment?: string; environmentId?: number }> }).actions;

    await patch({ ciRerun: settings([github({ environmentId: staging!.id })]) });
    expect((await actions())[0]).toMatchObject({ environment: 'staging', environmentId: staging!.id });
    // A label resolves as a run's does, ignoring case, and is kept as written.
    await patch({ ciRerun: settings([github({ environment: 'STG' })]) });
    expect((await actions())[0]).toMatchObject({ environment: 'STG', environmentId: staging!.id });

    await expect(patch({ ciRerun: settings([github({ environmentId: foreign!.id })]) })).rejects.toMatchObject({
      statusCode: 400,
      message: 'The CI action “Smoke” names an environment this project does not have.',
    });
    await expect(patch({ ciRerun: settings([github({ environmentId: archived!.id })]) })).rejects.toMatchObject({
      statusCode: 400,
      message: 'The CI action “Smoke” names Old, which is archived.',
    });
    expect((await actions())[0]!.environmentId).toBe(staging!.id);

    await db
      .update(schema.projects)
      .set({ ciRerun: settings([github({ environment: 'old', environmentId: archived!.id })]) as never })
      .where(eq(schema.projects.id, 1));
    await patch({ ciRerun: settings([github({ environmentId: archived!.id, name: 'Renamed' })]) });
    expect((await actions())[0]).toMatchObject({ environment: 'old', environmentId: archived!.id });
  });
});

describe('listProjects', () => {
  test('returns the actions of a project whose stored value has none, converted', async () => {
    await db
      .update(schema.projects)
      .set({
        ciRerun: {
          enabled: true,
          via: 'ci-server',
          ciServer: { preset: 'jenkins', rerun: { job: 'e2e' } },
          github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' },
        } as never,
      })
      .where(eq(schema.projects.id, 1));
    const project = (
      (await listProjects(db as never)) as unknown as Array<{ id: number; ciRerun: Record<string, unknown> }>
    ).find((p) => p.id === 1);
    const ciRerun = project!.ciRerun as { enabled: boolean; actions: Array<{ id: string }>; defaults: unknown };
    expect(ciRerun.enabled).toBe(true);
    expect(ciRerun.actions.map((a) => a.id).sort()).toEqual(['rerun-ci-server', 'rerun-github']);
    expect(ciRerun.defaults).toEqual({ rerun: 'rerun-ci-server' });
  });

  test('returns null for a project with no CI settings', async () => {
    const project = ((await listProjects(db as never)) as unknown as Array<{ id: number; ciRerun: unknown }>).find(
      (p) => p.id === 1,
    );
    expect(project!.ciRerun).toBeNull();
  });
});
