import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Saving CI actions through the server's project route and through the demo router: both answer HTTP 400 for a
 * payload that breaks a limit or would seal the one CI server token to more than one base URL, and both leave the
 * stored settings as they were.
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
const { openCiServerToken } = await import('../../server/utils/ci-server-dispatch');
const { listProjects } = await import('../../shared/handlers/projects');

const A = 'https://a.example.com/';
const B = 'https://b.example.com/';

const server = (id: string, baseUrl?: string) => ({
  id,
  name: id,
  target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' }, ...(baseUrl ? { baseUrl } : {}) },
  inputs: [],
  accepts: ['tests'],
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
  process.env.PIWI_SECRET_KEY = 'a-test-key-for-the-ci-server-token';
  ({ db, close } = await openTempDb());
  state.db = db;
});

afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});

beforeEach(async () => {
  await db.delete(schema.projects);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
});

afterEach(() => {
  delete process.env.PIWI_CI_SERVER_URL;
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

describe.each(routes)('PATCH of CI actions through %s', (name, patch) => {
  const isServer = name === 'the server route';

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

  test('answers 400 for a token when two actions send to different base URLs', async () => {
    await expect(
      patch({ ciRerun: settings([server('a', A), server('b', B)]), ciServerToken: 'secret' }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('different base URLs') });
    expect((await stored()).ciServerToken).toBeNull();
    // The same actions save without a token.
    await expect(patch({ ciRerun: settings([server('a', A), server('b', B)]) })).resolves.toBeDefined();
  });

  test('seals the token to the one URL the actions share', async () => {
    await patch({ ciRerun: settings([server('a', A), server('b', A)]), ciServerToken: ' secret ' });
    const row = await stored();
    expect(row.ciServerToken).not.toBeNull();
    if (isServer) expect(openCiServerToken(row.ciServerToken)).toEqual({ url: A, token: 'secret' });
    else expect(row.ciServerToken).toContain(A);
  });

  test('keeps the stored actions when only the token is sent, and 400s when they now use two URLs', async () => {
    await patch({ ciRerun: settings([server('a', A), server('b', B)]) });
    await expect(patch({ ciServerToken: 'secret' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('PATCH of a token through the server route when the instance has a CI server', () => {
  test('answers 400 when an action with no URL of its own and one with its own would both send', async () => {
    process.env.PIWI_CI_SERVER_URL = 'https://instance.example.com/';
    await expect(
      serverPatch({ ciRerun: settings([server('a'), server('b', A)]), ciServerToken: 'secret' }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('different base URLs') });
  });

  test('seals to the instance URL when no action has its own', async () => {
    process.env.PIWI_CI_SERVER_URL = 'https://instance.example.com/';
    await serverPatch({ ciRerun: settings([server('a')]), ciServerToken: 'secret' });
    expect(openCiServerToken((await stored()).ciServerToken)).toEqual({
      url: 'https://instance.example.com/',
      token: 'secret',
    });
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
    const [project] = (await listProjects(db as never)) as unknown as Array<{ ciRerun: Record<string, unknown> }>;
    const ciRerun = project!.ciRerun as { enabled: boolean; actions: Array<{ id: string }>; defaults: unknown };
    expect(ciRerun.enabled).toBe(true);
    expect(ciRerun.actions.map((a) => a.id).sort()).toEqual(['rerun-ci-server', 'rerun-github']);
    expect(ciRerun.defaults).toEqual({ rerun: 'rerun-ci-server' });
  });

  test('returns null for a project with no CI settings', async () => {
    const [project] = (await listProjects(db as never)) as unknown as Array<{ ciRerun: unknown }>;
    expect(project!.ciRerun).toBeNull();
  });
});
