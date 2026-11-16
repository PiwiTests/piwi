import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { ADMIN_ACCESS, InstanceRole } from '#shared/permissions';
import type { User } from '../../server/database/schema';
import { scmCredentialProblem, type CredentialInput } from '#shared/credentials';
import { scmApiDestination, scmDestinationHost } from '#shared/scm-urls';
import {
  ciActionsCredentialProblem,
  credentialReferences,
  insertCredential,
  instanceScmCredentialsProblem,
  projectScmCredentialProblem,
} from '#shared/handlers/credentials';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

/**
 * The SCM credentials: where one may be sent, which one a repository call
 * carries (a CI action's, the project's, the instance's), opening a provider
 * with it as one counted read and logging each write, the checks of a save,
 * and the import of the project and instance SCM tokens.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('setResponseStatus', () => {});

const { importScmTokens, sealCredentialSecret } = await import('../../server/utils/credentials');
const { encryptSecret } = await import('../../server/utils/crypto');
const { createScmProvider, openScmProvider, scmCredentialFor } = await import('../../server/utils/scm');
const { CredentialRefusedError } = await import('../../server/utils/credentials');
const { GitHubProvider } = await import('../../server/utils/scm/GitHubProvider');
const { GitLabProvider } = await import('../../server/utils/scm/GitLabProvider');
const { BitbucketProvider } = await import('../../server/utils/scm/BitbucketProvider');

type Handler = (event: FakeEvent) => Promise<{ credential: Record<string, unknown> } & Record<string, unknown>>;
const createCredentialRoute = underRoutePermission(
  state,
  (await import('../../server/api/credentials/index.post')).default as unknown as Handler,
);
const patchCredentialRoute = underRoutePermission(
  state,
  (await import('../../server/api/credentials/[id].patch')).default as unknown as Handler,
);

const SECRET_KEY = '0123456789abcdef'.repeat(4);
const STATUS = {
  state: 'success' as const,
  description: 'ok',
  context: 'piwi',
  targetUrl: 'https://piwi.example.com/',
};
const ADMIN = {
  user: { id: 1, username: 'avery', name: null, role: InstanceRole.ADMINISTRATOR } as unknown as User,
  access: ADMIN_ACCESS,
};
const GITHUB = 'https://api.github.com/';
const SHOP = 'https://github.com/acme/shop';

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.PIWI_SECRET_KEY = SECRET_KEY;
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values({ id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR });
});

afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
  vi.stubGlobal('eventHandler', (handler: unknown) => handler);
  vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
  vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
  vi.stubGlobal('apiError', apiError);
  vi.stubGlobal('setResponseStatus', () => {});
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
  await db.delete(schema.appSettings);
  await db.delete(schema.projects);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', repositoryUrl: SHOP },
    { id: 2, name: 'admin', repositoryUrl: 'https://github.com/acme/admin' },
    { id: 3, name: 'docs', repositoryUrl: 'https://gitlab.com/acme/docs' },
  ]);
});

/** An SCM credential set in the database, its token sealed for its destination. */
async function scmCredential(
  over: Partial<Omit<CredentialInput, 'secret'>> & { secret?: string } = {},
): Promise<number> {
  const { secret = 'ghp_team', ...fields } = over;
  const input: Omit<CredentialInput, 'secret'> = {
    name: `GitHub ${Math.random()}`,
    description: null,
    service: 'scm',
    user: null,
    destination: GITHUB,
    scope: { allProjects: true },
    allowedInputs: null,
    customRequests: false,
    disabled: false,
    ...fields,
  };
  return insertCredential(db as never, input, sealCredentialSecret(input.destination, secret), null);
}

const listInstance = (ids: number[]) =>
  db.insert(schema.appSettings).values({ key: 'scm_credentials', value: { ids } });
const uses = () => db.select().from(schema.credentialUses).orderBy(asc(schema.credentialUses.id));

/** A fetch that answers 201 with an id, a sha and a number, and records each request's method, URL and Authorization header. */
function recordFetch() {
  const calls: { method: string; url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      calls.push({ method: init.method ?? 'GET', url: String(url), auth: init.headers?.Authorization ?? null });
      // A pull request's comments: none yet, so a comment is posted.
      if ((init.method ?? 'GET') === 'GET' && String(url).includes('/comments')) return new Response('[]');
      return new Response(JSON.stringify({ id: 9, sha: 'f00d', number: 3, html_url: 'https://example.test/pr/3' }), {
        status: 201,
      });
    }),
  );
  return calls;
}

describe('where an SCM credential may be sent', () => {
  test('a host’s API, whole or narrowed to its repositories, over https', () => {
    expect(scmDestinationHost('https://api.github.com/')).toBe('github');
    expect(scmDestinationHost('https://api.github.com/repos/acme/')).toBe('github');
    expect(scmDestinationHost('https://api.bitbucket.org/2.0/repositories/acme/')).toBe('bitbucket');
    expect(scmDestinationHost('https://gitlab.com/api/v4/projects/acme%2Fdocs/')).toBe('gitlab');
    expect(scmDestinationHost('https://gitlab.example.com/', new Set(['gitlab.example.com']))).toBe('gitlab');
    // Another path of the API, another host, an unlisted GitLab, plain http or another port.
    expect(scmDestinationHost('https://api.github.com/user/')).toBeNull();
    expect(scmDestinationHost('https://github.com/')).toBeNull();
    expect(scmDestinationHost('https://gitlab.example.com/')).toBeNull();
    expect(scmDestinationHost('http://api.github.com/')).toBeNull();
    expect(scmDestinationHost('https://api.github.com:8443/')).toBeNull();
  });

  test('names no user, since the token goes as a bearer token', () => {
    expect(scmCredentialProblem({ destination: GITHUB, user: null })).toBeNull();
    expect(scmCredentialProblem({ destination: GITHUB, user: 'bot' })).toMatch(/names no user/);
    expect(scmCredentialProblem({ destination: 'https://jenkins.example.com/', user: null })).toMatch(
      /is sent to https:\/\/api\.github\.com\//,
    );
  });

  test('a repository’s host API is the destination an import or a new credential starts with', () => {
    expect(scmApiDestination(SHOP)).toBe(GITHUB);
    expect(scmApiDestination('https://bitbucket.org/acme/shop')).toBe('https://api.bitbucket.org/');
    expect(scmApiDestination('https://gitlab.example.com/acme/shop')).toBe('https://gitlab.example.com/');
    expect(scmApiDestination('https://git.example.com/acme/shop')).toBeNull();
  });

  test('a create of an SCM credential refuses a user or another destination, and drops the CI server switches', async () => {
    state.caller = ADMIN;
    const body = (over: Record<string, unknown>) => ({
      body: {
        name: `GitHub ${Math.random()}`,
        service: 'scm',
        secret: 'ghp_x',
        destination: GITHUB,
        scope: { allProjects: true },
        ...over,
      },
    });
    await expect(createCredentialRoute(body({ user: 'bot' }))).rejects.toMatchObject({ statusCode: 400 });
    await expect(createCredentialRoute(body({ destination: 'https://ci.example.com/' }))).rejects.toMatchObject({
      statusCode: 400,
    });
    const created = await createCredentialRoute(body({ customRequests: true, allowedInputs: ['A'] }));
    expect(created.credential).toMatchObject({ service: 'scm', customRequests: false, allowedInputs: null });
  });

  test('an instance credential stays shared with all projects while the instance lists it', async () => {
    state.caller = ADMIN;
    const id = await scmCredential();
    await listInstance([id]);
    await expect(
      patchCredentialRoute({ params: { id: String(id) }, body: { scope: { allProjects: false, projectIds: [1] } } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('which credential a repository call carries', () => {
  const api = 'https://api.github.com/repos/acme/shop';

  test('the CI action’s, else the project’s, else the instance’s whose destination holds the repository, narrowest first', async () => {
    const wide = await scmCredential({ name: 'wide' });
    const acme = await scmCredential({ name: 'acme', destination: 'https://api.github.com/repos/acme/' });
    const other = await scmCredential({ name: 'other', destination: 'https://api.github.com/repos/other/' });
    expect(await scmCredentialFor(db as never, 1, api)).toBeNull();
    await listInstance([wide, other, acme]);
    expect(await scmCredentialFor(db as never, 1, api)).toBe(acme);
    expect(await scmCredentialFor(db as never, 1, 'https://api.github.com/repos/third/x')).toBe(wide);
    expect(await scmCredentialFor(db as never, null, api)).toBe(acme);

    const own = await scmCredential({ name: 'own', scope: { allProjects: false, projectIds: [1] } });
    await db.update(schema.projects).set({ scmCredentialId: own }).where(eq(schema.projects.id, 1));
    expect(await scmCredentialFor(db as never, 1, api)).toBe(own);
    expect(await scmCredentialFor(db as never, 1, api, other)).toBe(other);
  });

  test('opening one is a counted read, and the provider carries its token', async () => {
    const id = await scmCredential({ secret: 'ghp_open' });
    await listInstance([id]);
    const calls = recordFetch();
    const provider = await openScmProvider(db as never, 1, SHOP);
    expect(provider?.hasToken).toBe(true);
    await provider!.fetchPullRequest(3);
    expect(calls.at(-1)?.auth).toBe('Bearer ghp_open');
    await openScmProvider(db as never, 1, SHOP);
    expect(await uses()).toMatchObject([
      { credentialId: id, feature: 'scm-read', projectId: 1, result: 'ok', count: 2, destination: api },
    ]);
  });

  test('a refused credential is logged, and the repository is read without a token; strict, the call is refused', async () => {
    const id = await scmCredential({ disabled: true });
    await listInstance([id]);
    const provider = await openScmProvider(db as never, 1, SHOP);
    expect(provider?.hasToken).toBe(false);
    expect(await uses()).toMatchObject([{ feature: 'scm-read', result: 'refused' }]);
    await expect(openScmProvider(db as never, 1, SHOP, { strict: true })).rejects.toBeInstanceOf(
      CredentialRefusedError,
    );
  });

  test('a credential bound to another host or owner never goes with the repository', async () => {
    const id = await scmCredential({ destination: 'https://api.github.com/repos/other/' });
    await db.update(schema.projects).set({ scmCredentialId: id }).where(eq(schema.projects.id, 1));
    const calls = recordFetch();
    const provider = await createScmProvider(SHOP, db as never, 1);
    await provider?.fetchPullRequest(3);
    expect(calls.every((call) => call.auth === null)).toBe(true);
    expect((await uses())[0]).toMatchObject({ result: 'refused', reason: expect.stringMatching(/sent only under/) });
  });

  test('each write is a row of its own, with its feature and subject, checked again before it is sent', async () => {
    const id = await scmCredential();
    await listInstance([id]);
    recordFetch();
    const provider = await openScmProvider(db as never, 1, SHOP, { actor: { userId: 1, apiKeyId: null } });
    expect(await provider!.postCommitStatus('a'.repeat(40), STATUS)).toBe(true);
    expect(await provider!.postPullRequestComment(7, '<!-- piwi -->', 'body')).not.toBeNull();
    await db.update(schema.credentials).set({ disabled: true }).where(eq(schema.credentials.id, id));
    // Disabled since it was opened: the next write is refused and sends nothing, and reports nothing posted.
    expect(await provider!.postCommitStatus('b'.repeat(40), STATUS)).toBe(false);
    const rows = (await uses()).filter((row) => row.feature !== 'scm-read');
    expect(rows).toMatchObject([
      { feature: 'scm-status', subjectType: 'commit', subjectId: 'a'.repeat(40), result: 'ok', userId: 1 },
      { feature: 'scm-comment', subjectType: 'pull-request', subjectId: '7', result: 'ok' },
      { feature: 'scm-status', subjectId: 'b'.repeat(40), result: 'refused' },
    ]);
  });
});

describe('every write of a provider goes through its gate', () => {
  const providers = () => [
    new GitHubProvider('acme/shop', 'tok'),
    new GitLabProvider('gitlab.com', 'acme/shop', 'tok'),
    new BitbucketProvider('acme', 'shop', 'tok'),
  ];

  test('comments, statuses, heal branches, commits and pull requests, and dispatches', async () => {
    recordFetch();
    for (const provider of providers()) {
      const seen: string[] = [];
      provider.gateWrites(async (write, run) => {
        seen.push(`${write.feature}:${write.subject?.type ?? ''}`);
        return run();
      });
      await provider.postCommitStatus('a'.repeat(40), STATUS);
      await provider.postPullRequestComment(7, '<!-- piwi -->', 'body');
      await provider.createBranch('heal/x', 'a'.repeat(40)).catch(() => {});
      await provider.commitFiles('heal/x', 'fix', [{ path: 'a.spec.ts', content: 'x' }]).catch(() => {});
      await provider
        .createPullRequest({ title: 't', body: 'b', head: 'heal/x', base: 'main', draft: false })
        .catch(() => {});
      const target =
        provider.provider === 'github'
          ? { type: 'github' as const, workflow: 'e2e.yml', ref: 'main', argsInput: 'args' }
          : provider.provider === 'gitlab'
            ? { type: 'gitlab' as const, ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' }
            : { type: 'bitbucket' as const, pipeline: 'rerun', argsVariable: 'PIWI_RERUN_ARGS' };
      await provider.dispatchRerun(target, 'x', { actionId: 'nightly' }).catch(() => {});
      expect(seen, provider.provider ?? '').toEqual([
        'scm-status:commit',
        'scm-comment:pull-request',
        'scm-pull-request:branch',
        'scm-pull-request:branch',
        'scm-pull-request:branch',
        'ci-dispatch:ci-action',
      ]);
    }
  });
});

describe('a save naming an SCM credential', () => {
  test('a repository-host CI action names one shared with the project, sent to its host’s API', async () => {
    const github = await scmCredential({ scope: { allProjects: false, projectIds: [1] } });
    const gitlab = await scmCredential({ destination: 'https://gitlab.com/', scope: { allProjects: true } });
    const ci = await insertCredential(
      db as never,
      {
        name: 'Jenkins',
        description: null,
        service: 'ci-server',
        user: null,
        destination: 'https://ci.example.com/',
        scope: { allProjects: true },
        allowedInputs: null,
        customRequests: false,
        disabled: false,
      },
      sealCredentialSecret('https://ci.example.com/', 'x'),
      null,
    );
    const action = (credentialId: number, type = 'github') => ({
      actions: [
        {
          id: 'gh',
          name: 'gh',
          target: { type, workflow: 'e2e.yml', ref: 'main', argsInput: 'args', argsVariable: 'A', credentialId },
        },
      ],
    });
    expect(await ciActionsCredentialProblem(db as never, 1, action(github))).toBeNull();
    expect(await ciActionsCredentialProblem(db as never, 2, action(github))).toMatch(/no SCM credential/);
    expect(await ciActionsCredentialProblem(db as never, 1, action(ci))).toMatch(/no SCM credential/);
    expect(await ciActionsCredentialProblem(db as never, 1, action(gitlab))).toMatch(/not to the API of this action/);
    expect(await ciActionsCredentialProblem(db as never, 1, action(gitlab, 'gitlab'))).toBeNull();
  });

  test('a project names one shared with it, for its repository’s host; the instance only ones shared with all', async () => {
    const own = await scmCredential({ scope: { allProjects: false, projectIds: [1] } });
    const gitlab = await scmCredential({ destination: 'https://gitlab.com/' });
    expect(await projectScmCredentialProblem(db as never, 1, own, SHOP)).toBeNull();
    expect(await projectScmCredentialProblem(db as never, 2, own, SHOP)).toMatch(/No SCM credential/);
    expect(await projectScmCredentialProblem(db as never, 1, gitlab, SHOP)).toMatch(/not to the API/);
    expect(await projectScmCredentialProblem(db as never, 1, gitlab, null)).toBeNull();
    expect(await instanceScmCredentialsProblem(db as never, [gitlab])).toBeNull();
    expect(await instanceScmCredentialsProblem(db as never, [own])).toMatch(/not shared with all projects/);
    expect(await instanceScmCredentialsProblem(db as never, [999])).toMatch(/No SCM credential/);
  });

  test('what names a credential: a CI action, a project’s source control, the instance’s', async () => {
    const id = await scmCredential();
    await listInstance([id]);
    await db
      .update(schema.projects)
      .set({
        scmCredentialId: id,
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'gh',
              name: 'Dispatch',
              target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args', credentialId: id },
              inputs: [],
              accepts: ['tests'],
            },
          ],
          defaults: {},
        } as never,
      })
      .where(eq(schema.projects.id, 1));
    expect((await credentialReferences(db as never)).get(id)).toEqual([
      { kind: 'instance-scm', projectId: null, projectName: null, actionId: null, name: 'Source control' },
      { kind: 'project-scm', projectId: 1, projectName: 'shop', actionId: null, name: 'Source control' },
      { kind: 'ci-action', projectId: 1, projectName: 'shop', actionId: 'gh', name: 'Dispatch' },
    ]);
  });
});

describe('importScmTokens', () => {
  const seal = (token: string) => encryptSecret(token, SECRET_KEY);
  const credentialRows = () => db.select().from(schema.credentials).orderBy(asc(schema.credentials.id));
  const project = async (id: number) => (await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0]!;

  test('moves each project token to a credential bound to its repository’s API, shared with it and named by it', async () => {
    await db
      .update(schema.projects)
      .set({ scmToken: seal('ghp_shop') })
      .where(eq(schema.projects.id, 1));
    await db
      .update(schema.projects)
      .set({ scmToken: seal('ghp_shop') })
      .where(eq(schema.projects.id, 2));
    await db
      .update(schema.projects)
      .set({ scmToken: seal('glpat_docs') })
      .where(eq(schema.projects.id, 3));
    expect(await importScmTokens(db as never)).toBe(3);

    const rows = await credentialRows();
    // Two projects holding the same token for one API share one credential.
    expect(rows.map((r) => [r.service, r.destination, r.allProjects, r.createdBy])).toEqual([
      ['scm', GITHUB, false, null],
      ['scm', 'https://gitlab.com/', false, null],
    ]);
    expect((await project(1)).scmCredentialId).toBe(rows[0]!.id);
    expect((await project(2)).scmCredentialId).toBe(rows[0]!.id);
    expect((await project(3)).scmCredentialId).toBe(rows[1]!.id);
    expect((await project(1)).scmToken).toBeNull();
    const shared = await db.select().from(schema.credentialProjects);
    expect(shared.map((r) => [r.credentialId, r.projectId]).sort()).toEqual(
      [
        [rows[0]!.id, 1],
        [rows[0]!.id, 2],
        [rows[1]!.id, 3],
      ].sort(),
    );
    // The credential opens with the token, for the repository it served.
    const calls = recordFetch();
    await (await openScmProvider(db as never, 3, 'https://gitlab.com/acme/docs'))!.fetchPullRequest(1);
    expect(calls.at(-1)?.auth).toBe('Bearer glpat_docs');
    expect(await importScmTokens(db as never)).toBe(0);
  });

  test('moves the instance token to one credential per API it served, shared with all projects and listed', async () => {
    await db.insert(schema.appSettings).values({ key: 'scm_token', value: { value: seal('ghp_instance') } });
    expect(await importScmTokens(db as never)).toBe(1);
    const rows = await credentialRows();
    expect(rows.map((r) => [r.destination, r.allProjects])).toEqual([
      [GITHUB, true],
      ['https://gitlab.com/', true],
    ]);
    const settings = await db.select().from(schema.appSettings);
    expect(settings).toMatchObject([{ key: 'scm_credentials', value: { ids: rows.map((r) => r.id) } }]);
    const calls = recordFetch();
    await (await openScmProvider(db as never, 2, 'https://github.com/acme/admin'))!.fetchPullRequest(1);
    expect(calls.at(-1)?.auth).toBe('Bearer ghp_instance');
  });

  test('a token waits for its project’s repository, and moves once a run pins one', async () => {
    await db.insert(schema.projects).values({ id: 4, name: 'new', scmToken: seal('ghp_new') });
    expect(await importScmTokens(db as never)).toBe(0);
    expect((await project(4)).scmToken).not.toBeNull();
    const { pinProjectRepository } = await import('../../server/utils/scm/project-repository');
    await pinProjectRepository(db as never, 4, { scm: { remoteUrl: 'git@github.com:acme/new.git' } });
    expect((await project(4)).scmToken).toBeNull();
    expect((await project(4)).scmCredentialId).toBe((await credentialRows())[0]!.id);
  });

  test('leaves a token that cannot be opened as it is', async () => {
    await db
      .update(schema.projects)
      .set({ scmToken: encryptSecret('ghp_other', 'f'.repeat(64)) })
      .where(eq(schema.projects.id, 1));
    expect(await importScmTokens(db as never)).toBe(0);
    expect((await project(1)).scmToken).not.toBeNull();
    expect(await credentialRows()).toEqual([]);
  });
});
