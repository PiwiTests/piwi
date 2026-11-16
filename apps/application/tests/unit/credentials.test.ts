import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { User } from '../../server/database/schema';
import { apiError } from '../../server/utils/api-error';
import { ADMIN_ACCESS, buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { resolveCiActionsSettings } from '#shared/ci-actions';
import {
  credentialRefusal,
  parseCredentialInput,
  type CredentialInput,
  type CredentialRules,
} from '#shared/credentials';
import {
  canManageCredential,
  canReadCredential,
  ciActionsCredentialProblem,
  credentialScopeRefusal,
  listCredentialUses,
  insertCredential,
  loadCredentialRecord,
  updateCredential,
  type CredentialViewer,
} from '#shared/handlers/credentials';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

/**
 * The credential manager: reading a posted credential, the rules that refuse a
 * use, the one way to a secret (`withCredential`) and its log, who manages a
 * credential, the credential the environment sets, a secret read from a
 * server variable, and the import of the project CI server tokens.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

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

const {
  CredentialRefusedError,
  ensureEnvCredentials,
  importProjectCiServerTokens,
  instanceCredential,
  pruneCredentialUses,
  maskCredentialAnswer,
  sealCredentialEnv,
  sealCredentialSecret,
  withCredential,
  withSecretEnvState,
} = await import('../../server/utils/credentials');
const { encryptSecret } = await import('../../server/utils/crypto');
const { ciServerBaseUrl, ciServerCredential } = await import('../../server/utils/ci-server-dispatch');
const { ciServerTargetOf } = await import('#shared/ci-actions');

type Handler = (event: FakeEvent) => Promise<{ credential: Record<string, unknown> } & Record<string, unknown>>;
const patchCredential = underRoutePermission(
  state,
  (await import('../../server/api/credentials/[id].patch')).default as unknown as Handler,
);
const deleteCredentialRoute = underRoutePermission(
  state,
  (await import('../../server/api/credentials/[id].delete')).default as unknown as Handler,
);
const createCredentialRoute = underRoutePermission(
  state,
  (await import('../../server/api/credentials/index.post')).default as unknown as Handler,
);

const SECRET_KEY = '0123456789abcdef'.repeat(4);
const DEST = 'https://ci.example.com/job/qa/';
const ENV = ['PIWI_CI_SERVER_URL', 'PIWI_CI_SERVER_USER', 'PIWI_CI_SERVER_TOKEN', 'PIWI_CI_SERVER_ALLOWED_INPUTS'];

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.PIWI_SECRET_KEY = SECRET_KEY;
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: 2, username: 'quinn', password: '', role: InstanceRole.MEMBER },
  ]);
});

afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});

beforeEach(async () => {
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
  await db.delete(schema.projects);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin' },
    { id: 3, name: 'billing' },
  ]);
});

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  vi.useRealTimers();
});

/** A credential set in the database, its secret sealed for its destination. */
async function create(
  over: Partial<Omit<CredentialInput, 'secret'>> & { secret?: string; createdBy?: number | null } = {},
): Promise<number> {
  const { secret = 'team-secret', createdBy = null, ...fields } = over;
  const input: Omit<CredentialInput, 'secret'> = {
    name: 'Team Jenkins',
    description: null,
    service: 'ci-server',
    user: 'team-bot',
    destination: DEST,
    scope: { allProjects: false, projectIds: [1] },
    allowedInputs: null,
    customRequests: false,
    disabled: false,
    ...fields,
  };
  return insertCredential(db as never, input, sealCredentialSecret(input.destination, secret), createdBy);
}

/** A dispatch of the `nightly` CI action of project 1, started by user 1. */
const useOf = (credentialId: number, over: Record<string, unknown> = {}) => ({
  credentialId,
  feature: 'ci-dispatch' as const,
  projectId: 1,
  url: `${DEST}job/e2e/buildWithParameters`,
  custom: false,
  actor: { userId: 1, apiKeyId: null },
  subject: { type: 'ci-action', id: 'nightly' },
  ...over,
});

const uses = () => db.select().from(schema.credentialUses).orderBy(asc(schema.credentialUses.id));

describe('parseCredentialInput', () => {
  const create = {
    name: 'Team Jenkins',
    service: 'ci-server',
    secret: 's3cret',
    destination: 'https://ci.example.com/',
    scope: { allProjects: true },
  };
  const error = (body: unknown, partial = false) => parseCredentialInput(body, { partial }).error;

  test('reads a create, trimmed and normalized', () => {
    expect(
      parseCredentialInput(
        {
          name: '  Team Jenkins ',
          description: '   ',
          service: 'ci-server',
          user: ' team-bot ',
          secret: ' s3cret ',
          destination: 'https://ci.example.com/job/qa',
          scope: { allProjects: false, projectIds: [3, 1, 3] },
          allowedInputs: [' SUITE ', 'SUITE', '', 'TARGET_ENV'],
          customRequests: true,
          disabled: false,
        },
        { partial: false },
      ),
    ).toEqual({
      error: null,
      value: {
        name: 'Team Jenkins',
        description: null,
        service: 'ci-server',
        user: 'team-bot',
        secret: 's3cret',
        destination: 'https://ci.example.com/job/qa/',
        scope: { allProjects: false, projectIds: [1, 3] },
        allowedInputs: ['SUITE', 'TARGET_ENV'],
        customRequests: true,
        disabled: false,
      },
    });
  });

  test('keeps every input when the allowed inputs are null, and none when they are empty', () => {
    expect(parseCredentialInput({ ...create, allowedInputs: null }, { partial: false }).value).toMatchObject({
      scope: { allProjects: true },
      allowedInputs: null,
    });
    expect(parseCredentialInput({ ...create, allowedInputs: [] }, { partial: false }).value?.allowedInputs).toEqual([]);
  });

  test('needs every field of a create but the description, the user, the allowed inputs and the switches', () => {
    expect(parseCredentialInput(create, { partial: false }).error).toBeNull();
    const without = (key: keyof typeof create) => {
      const { [key]: _dropped, ...rest } = create;
      return rest;
    };
    expect(error(without('name'))).toBe('A credential needs a name.');
    expect(error(without('service'))).toBe('The service is one of ci-server, scm, ai.');
    expect(error(without('secret'))).toBe('A credential needs its secret, or the variable it is read from.');
    expect(error({ ...create, secret: '   ' })).toBe('A credential needs its secret, or the variable it is read from.');
    expect(error(without('destination'))).toMatch(/http\(s\) URL/);
    expect(error(without('scope'))).toMatch(/allProjects/);
  });

  test('reads only the fields an update holds', () => {
    expect(parseCredentialInput({}, { partial: true })).toEqual({ value: {}, error: null });
    expect(parseCredentialInput({ disabled: true }, { partial: true }).value).toEqual({ disabled: true });
    expect(parseCredentialInput({ secret: ' rotated ' }, { partial: true }).value).toEqual({ secret: 'rotated' });
    expect(parseCredentialInput({ user: '' }, { partial: true }).value).toEqual({ user: null });
  });

  test('refuses a body that is not an object', () => {
    for (const body of [null, 'x', [], 3]) expect(error(body)).toBe('The body must be an object.');
  });

  test('refuses a field over its limit, and a line break in a secret or a user name', () => {
    expect(error({ ...create, name: 'n'.repeat(81) })).toContain('at most 80');
    expect(error({ ...create, description: 'd'.repeat(501) })).toContain('at most 500');
    expect(error({ ...create, user: 'u'.repeat(201) })).toContain('at most 200');
    expect(error({ ...create, secret: 's'.repeat(8193) })).toContain('at most 8192');
    expect(error({ ...create, secret: 'a\nb' })).toBe('A secret holds no line break.');
    expect(error({ ...create, secret: 'a\0b' })).toBe('A secret holds no line break.');
    expect(error({ ...create, user: 'bot\r\nX-Injected: 1' })).toBe('A user name holds no line break.');
    expect(error({ ...create, service: 'smtp' })).toBe('The service is one of ci-server, scm, ai.');
  });

  test('refuses a destination that is not a plain http(s) base URL', () => {
    for (const destination of [
      'ftp://ci.example.com/',
      'https://user:pass@ci.example.com/',
      'https://ci.example.com/?a=1',
      'https://ci.example.com/#x',
      'ci.example.com',
      42,
    ]) {
      expect(error({ ...create, destination }), String(destination)).toMatch(/http\(s\) URL/);
    }
    expect(error({ ...create, destination: 'https://ci.example.com/job/qa/..%2F..%2Fadmin/' })).toMatch(
      /climbs once decoded/,
    );
  });

  test('refuses a scope that names no project, or a project that is not a positive whole number', () => {
    expect(error({ ...create, scope: 'all' })).toMatch(/allProjects/);
    expect(error({ ...create, scope: { allProjects: false } })).toMatch(/Name the projects/);
    for (const id of [0, -1, 1.5, '1', null]) {
      expect(error({ ...create, scope: { allProjects: false, projectIds: [id] } })).toBe(
        'A project id is a positive whole number.',
      );
    }
    const many = Array.from({ length: 501 }, (_, i) => i + 1);
    expect(error({ ...create, scope: { allProjects: false, projectIds: many } })).toContain('at most 500 projects');
  });

  test('refuses allowed inputs that are not a list of input names, or too many', () => {
    expect(error({ ...create, allowedInputs: 'SUITE' })).toMatch(/list of input names/);
    expect(error({ ...create, allowedInputs: ['9bad'] })).toContain('"9bad" is not an input name');
    expect(error({ ...create, allowedInputs: ['A-B'] })).toContain('is not an input name');
    const many = Array.from({ length: 51 }, (_, i) => `IN_${i}`);
    expect(error({ ...create, allowedInputs: many })).toContain('at most 50 allowed inputs');
  });

  test('refuses a switch that is not a boolean', () => {
    expect(error({ ...create, customRequests: 'yes' })).toBe('customRequests is true or false.');
    expect(error({ disabled: 1 }, true)).toBe('disabled is true or false.');
  });
});

describe('credentialRefusal', () => {
  const rules: CredentialRules = {
    name: 'Team Jenkins',
    destination: DEST,
    allProjects: false,
    projectIds: [1],
    customRequests: false,
    disabled: false,
  };
  const use = { projectId: 1, url: `${DEST}job/e2e/buildWithParameters`, custom: false };

  test('lets a use of a project it is shared with, under its destination, go', () => {
    expect(credentialRefusal(rules, use)).toBeNull();
    expect(credentialRefusal({ ...rules, allProjects: true, projectIds: [] }, { ...use, projectId: 2 })).toBeNull();
    expect(credentialRefusal({ ...rules, customRequests: true }, { ...use, custom: true })).toBeNull();
  });

  test('refuses a disabled credential', () => {
    expect(credentialRefusal({ ...rules, disabled: true }, use)).toBe('The credential "Team Jenkins" is disabled.');
  });

  test('refuses a project outside its scope, and a use without a project', () => {
    for (const projectId of [2, null]) {
      expect(credentialRefusal(rules, { ...use, projectId })).toBe(
        'The credential "Team Jenkins" is not shared with this project.',
      );
    }
  });

  test('refuses a URL outside its destination, naming where the request goes without its query', () => {
    expect(credentialRefusal(rules, { ...use, url: 'https://ci.example.com/job/qa-other/build?token=abc' })).toBe(
      `The credential "Team Jenkins" is sent only under ${DEST}, and this request goes to https://ci.example.com/job/qa-other/build.`,
    );
    for (const url of [
      'https://ci.example.com/job/other/build',
      'http://ci.example.com/job/qa/build',
      'https://ci.example.com:8443/job/qa/build',
      'https://ci.example.com.attacker.example/job/qa/build',
      'https://bot@ci.example.com/job/qa/build',
      'https://ci.example.com/job/qa/..%2F..%2FscriptText',
    ]) {
      expect(credentialRefusal(rules, { ...use, url }), url).toContain('is sent only under');
    }
    expect(credentialRefusal(rules, { ...use, url: 'not a url' })).toContain('this request goes to another address');
  });

  test('refuses a Custom request it does not allow', () => {
    expect(credentialRefusal(rules, { ...use, custom: true })).toBe(
      'The credential "Team Jenkins" does not go with a Custom request: allow it in its settings, or pick another.',
    );
  });

  test('names the first rule that fails: disabled, then the project, the destination and a Custom request', () => {
    const all = { projectId: 2, url: 'https://attacker.example/x', custom: true };
    expect(credentialRefusal({ ...rules, disabled: true }, all)).toContain('is disabled');
    expect(credentialRefusal(rules, all)).toContain('is not shared with this project');
    expect(credentialRefusal(rules, { ...all, projectId: 1 })).toContain('is sent only under');
    expect(credentialRefusal(rules, { ...all, projectId: 1, url: `${DEST}x` })).toContain('Custom request');
  });
});

describe('withCredential', () => {
  test('opens the secret for a use under its destination, and settles its log row from sent to ok', async () => {
    const id = await create();
    let during: unknown[] = [];
    const value = await withCredential(db as never, useOf(id), async (opened) => {
      expect(opened).toEqual({ user: 'team-bot', secret: 'team-secret' });
      during = await uses();
      return 'answered';
    });
    expect(value).toBe('answered');
    expect(during).toEqual([expect.objectContaining({ credentialId: id, result: 'sent', reason: null })]);
    expect(await uses()).toEqual([
      expect.objectContaining({
        credentialId: id,
        credentialName: 'Team Jenkins',
        feature: 'ci-dispatch',
        projectId: 1,
        userId: 1,
        apiKeyId: null,
        subjectType: 'ci-action',
        subjectId: 'nightly',
        destination: `${DEST}job/e2e/buildWithParameters`,
        result: 'ok',
        reason: null,
        count: 1,
      }),
    ]);
    expect((await loadCredentialRecord(db as never, id))!.lastUsedAt).not.toBeNull();
  });

  test('records a failure read from the answer, and returns the answer', async () => {
    const id = await create();
    const answer = await withCredential(
      db as never,
      useOf(id),
      async () => ({ status: 500 }),
      (value) => (value.status === 500 ? 'The CI server answered 500' : null),
    );
    expect(answer).toEqual({ status: 500 });
    expect(await uses()).toEqual([expect.objectContaining({ result: 'failed', reason: 'The CI server answered 500' })]);
  });

  test('masks the secret, and the Basic pairs it is sent in, in the stored reason and the thrown message', async () => {
    const secret = 'p@ss/w0rd+=';
    const id = await create({ secret });
    const forms = [
      secret,
      Buffer.from(`team-bot:${secret}`).toString('base64'),
      Buffer.from(`:${secret}`).toString('base64'),
      encodeURIComponent(secret),
    ];
    const thrown = await withCredential(db as never, useOf(id), async () => {
      throw new Error(`401 with ${forms[0]}, Authorization: Basic ${forms[1]}, ${forms[2]}, ?token=${forms[3]}`);
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    const [row] = await uses();
    expect(row).toMatchObject({ result: 'failed' });
    for (const text of [(thrown as Error).message, row!.reason!]) {
      expect(text).toContain('401 with ****');
      for (const form of forms) expect(text).not.toContain(form);
    }
  });

  test('rethrows an error that holds no secret as it is', async () => {
    const id = await create();
    const original = new TypeError('fetch failed');
    await expect(
      withCredential(db as never, useOf(id), async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(await uses()).toEqual([expect.objectContaining({ result: 'failed', reason: 'fetch failed' })]);
  });

  test('refuses a use outside its destination before anything is sent, and records the refusal', async () => {
    const id = await create();
    const send = vi.fn(async () => 'sent');
    const refused = await withCredential(
      db as never,
      useOf(id, { url: 'https://attacker.example/collect?token=1' }),
      send,
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CredentialRefusedError);
    expect((refused as Error).message).toContain('is sent only under');
    expect(send).not.toHaveBeenCalled();
    expect(await uses()).toEqual([
      expect.objectContaining({
        credentialId: id,
        result: 'refused',
        destination: 'https://attacker.example/collect',
        reason: (refused as Error).message,
        userId: 1,
        subjectId: 'nightly',
      }),
    ]);
    expect((await loadCredentialRecord(db as never, id))!.lastUsedAt).toBeNull();
  });

  test('refuses a project outside its scope, a Custom request it does not allow and a disabled credential', async () => {
    const id = await create();
    const send = vi.fn(async () => 'sent');
    await expect(withCredential(db as never, useOf(id, { projectId: 2 }), send)).rejects.toThrow(
      'is not shared with this project',
    );
    await expect(withCredential(db as never, useOf(id, { custom: true }), send)).rejects.toThrow(
      'does not go with a Custom request',
    );
    await updateCredential(db as never, id, { disabled: true });
    await expect(withCredential(db as never, useOf(id), send)).rejects.toThrow('is disabled');
    expect(send).not.toHaveBeenCalled();
    expect((await uses()).map((row) => [row.result, row.projectId])).toEqual([
      ['refused', 2],
      ['refused', 1],
      ['refused', 1],
    ]);
  });

  test('refuses a credential that was deleted, recording its id as its name', async () => {
    const send = vi.fn(async () => 'sent');
    await expect(withCredential(db as never, useOf(9999), send)).rejects.toThrow(
      'The credential was deleted: pick another one.',
    );
    expect(send).not.toHaveBeenCalled();
    expect(await uses()).toEqual([
      expect.objectContaining({ credentialId: null, credentialName: '#9999', result: 'refused' }),
    ]);
  });

  test('never opens a secret for a destination it was not sealed with, nor with another key', async () => {
    const id = await create();
    const send = vi.fn(async () => 'sent');
    await updateCredential(db as never, id, { destination: 'https://ci.moved.example/' });
    const moved = useOf(id, { url: 'https://ci.moved.example/job/e2e/build' });
    await expect(withCredential(db as never, moved, send)).rejects.toThrow(
      'The credential "Team Jenkins" cannot be opened: save its secret again.',
    );
    const other = await create({ name: 'Other key' });
    process.env.PIWI_SECRET_KEY = 'f'.repeat(64);
    try {
      await expect(withCredential(db as never, useOf(other), send)).rejects.toThrow('cannot be opened');
    } finally {
      process.env.PIWI_SECRET_KEY = SECRET_KEY;
    }
    expect(send).not.toHaveBeenCalled();
  });

  test('counts the reads of a credential in one row per project, result and hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T10:05:00Z'));
    const id = await create({ scope: { allProjects: false, projectIds: [1, 2] } });
    const read = (over: Record<string, unknown> = {}, failed: string | null = null) =>
      withCredential(
        db as never,
        useOf(id, { feature: 'ci-check', ...over }),
        async () => 'job',
        () => failed,
      );
    await read();
    vi.setSystemTime(new Date('2026-11-16T10:40:00Z'));
    await read();
    await read({ projectId: 2 });
    await read({}, 'The CI server answered 401');
    vi.setSystemTime(new Date('2026-11-16T10:59:00Z'));
    await read();
    vi.setSystemTime(new Date('2026-11-16T11:01:00Z'));
    await read();
    const rows = await uses();
    expect(rows.map((row) => [row.projectId, row.result, row.count])).toEqual([
      [1, 'ok', 3],
      [2, 'ok', 1],
      [1, 'failed', 1],
      [1, 'ok', 1],
    ]);
    expect(rows[0]).toMatchObject({
      feature: 'ci-check',
      createdAt: new Date('2026-11-16T10:05:00Z'),
      lastAt: new Date('2026-11-16T10:59:00Z'),
    });
    expect(rows[2]!.reason).toBe('The CI server answered 401');
    expect(rows.some((row) => row.result === 'sent')).toBe(false);
  });
});

describe('who manages a credential', () => {
  const admin: CredentialViewer = { access: ADMIN_ACCESS, userId: 1 };
  // Quinn: Project admin of projects 1 and 2, Maintainer of project 3.
  const quinn: CredentialViewer = {
    access: buildAccessSummary(InstanceRole.MEMBER, [
      { projectId: 1, role: ProjectRole.PROJECT_ADMIN },
      { projectId: 2, role: ProjectRole.PROJECT_ADMIN },
      { projectId: 3, role: ProjectRole.MAINTAINER },
    ]),
    userId: 2,
  };
  const record = (
    over: Partial<{
      allProjects: boolean;
      projectIds: number[];
      managedBy: 'db' | 'env';
      createdBy: number | null;
      secretEnv: string | null;
    }> = {},
  ) => ({
    allProjects: false,
    projectIds: [1],
    managedBy: 'db' as const,
    createdBy: 2,
    secretEnv: null,
    ...over,
  });

  test('an administrator manages every credential set in the database, never the environment’s', () => {
    expect(canManageCredential(admin, record({ createdBy: null, allProjects: true, projectIds: [] }))).toBe(true);
    expect(canManageCredential(admin, record({ createdBy: 2 }))).toBe(true);
    expect(canManageCredential(admin, record({ managedBy: 'env', allProjects: true }))).toBe(false);
  });

  test('a Project admin manages a credential they created, shared only with projects they manage', () => {
    expect(canManageCredential(quinn, record({ projectIds: [1, 2] }))).toBe(true);
    expect(canManageCredential(quinn, record({ projectIds: [1, 3] }))).toBe(false);
    expect(canManageCredential(quinn, record({ allProjects: true, projectIds: [] }))).toBe(false);
    expect(canManageCredential(quinn, record({ projectIds: [] }))).toBe(false);
    expect(canManageCredential(quinn, record({ managedBy: 'env' }))).toBe(false);
    expect(canManageCredential(quinn, record({ secretEnv: 'PIWI_CREDENTIAL_TEAM' }))).toBe(false);
  });

  test('a Project admin never manages an administrator’s credential, even one shared only with their project', () => {
    for (const createdBy of [1, null]) {
      const credential = { ...record({ createdBy }), id: 1 } as never;
      expect(canManageCredential(quinn, credential)).toBe(false);
      expect(canReadCredential(quinn, credential)).toBe(false);
      expect(canReadCredential(admin, credential)).toBe(true);
    }
    expect(canManageCredential({ ...quinn, userId: null }, record({ createdBy: null }))).toBe(false);
  });

  test('sharing with all projects takes credentials:manage, and a Project admin names only projects they manage', () => {
    expect(credentialScopeRefusal(ADMIN_ACCESS, { allProjects: true })).toBeNull();
    expect(credentialScopeRefusal(ADMIN_ACCESS, { allProjects: false, projectIds: [3] })).toBeNull();
    expect(credentialScopeRefusal(quinn.access, { allProjects: true })).toContain('credentials:manage');
    expect(credentialScopeRefusal(quinn.access, { allProjects: false, projectIds: [] })).toBe(
      'Name at least one project the credential is for.',
    );
    expect(credentialScopeRefusal(quinn.access, { allProjects: false, projectIds: [1, 2] })).toBeNull();
    expect(credentialScopeRefusal(quinn.access, { allProjects: false, projectIds: [1, 3] })).toBe(
      'A credential names only projects you manage.',
    );
  });
});

describe('the credential routes, called by a Project admin', () => {
  const avery = {
    user: { id: 1, username: 'avery', name: null, role: InstanceRole.ADMINISTRATOR } as unknown as User,
    access: ADMIN_ACCESS,
  };
  const quinn = {
    user: { id: 2, username: 'quinn', name: null, role: InstanceRole.MEMBER } as unknown as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.PROJECT_ADMIN }]),
  };
  const call = (handler: Handler, id: number, body?: unknown) => handler({ params: { id: String(id) }, body });

  test('cannot loosen or delete an administrator’s credential shared only with their project', async () => {
    const id = await create({ createdBy: 1 });
    state.caller = quinn;
    await expect(call(patchCredential, id, { customRequests: true })).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      call(patchCredential, id, { allowedInputs: null, destination: 'https://ci.example.com/' }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(call(deleteCredentialRoute, id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await loadCredentialRecord(db as never, id)).toMatchObject({ customRequests: false, destination: DEST });
    state.caller = avery;
    expect((await call(patchCredential, id, { customRequests: true })).credential).toMatchObject({
      customRequests: true,
      canManage: true,
    });
  });

  test('changes a credential they created, within the projects they manage', async () => {
    const id = await create({ createdBy: 2 });
    state.caller = quinn;
    expect((await call(patchCredential, id, { customRequests: true })).credential).toMatchObject({
      customRequests: true,
      canManage: true,
    });
    await expect(call(patchCredential, id, { scope: { allProjects: true } })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      call(patchCredential, id, { scope: { allProjects: false, projectIds: [1, 2] } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await call(deleteCredentialRoute, id)).toEqual({ ok: true });
  });
});

describe('the credential the environment sets', () => {
  const credentialRows = () =>
    db
      .select({
        id: schema.credentials.id,
        name: schema.credentials.name,
        destination: schema.credentials.destination,
        userName: schema.credentials.userName,
        secret: schema.credentials.secret,
        allProjects: schema.credentials.allProjects,
        allowedInputs: schema.credentials.allowedInputs,
        customRequests: schema.credentials.customRequests,
        managedBy: schema.credentials.managedBy,
      })
      .from(schema.credentials)
      .orderBy(asc(schema.credentials.id));

  function useEnv() {
    process.env.PIWI_CI_SERVER_URL = 'https://ci.example.com';
    process.env.PIWI_CI_SERVER_USER = 'piwi-bot';
    process.env.PIWI_CI_SERVER_TOKEN = 'env-secret';
    process.env.PIWI_CI_SERVER_ALLOWED_INPUTS = ' TARGET_ENV , SUITE ';
  }

  test('is a row without its secret, shared with all projects, kept in line with the variables and removed once unset', async () => {
    await ensureEnvCredentials(db as never);
    expect(await credentialRows()).toEqual([]);
    useEnv();
    await ensureEnvCredentials(db as never);
    const [row] = await credentialRows();
    expect(row).toEqual({
      id: expect.any(Number),
      name: 'CI server (environment)',
      destination: 'https://ci.example.com/',
      userName: 'piwi-bot',
      secret: null,
      allProjects: true,
      allowedInputs: ['TARGET_ENV', 'SUITE'],
      customRequests: false,
      managedBy: 'env',
    });
    process.env.PIWI_CI_SERVER_USER = 'other-bot';
    delete process.env.PIWI_CI_SERVER_ALLOWED_INPUTS;
    await ensureEnvCredentials(db as never);
    expect(await credentialRows()).toEqual([{ ...row, userName: 'other-bot', allowedInputs: [] }]);
    delete process.env.PIWI_CI_SERVER_TOKEN;
    await ensureEnvCredentials(db as never);
    expect(await credentialRows()).toEqual([]);
  });

  test('takes a free name beside a credential of the same name', async () => {
    await create({ name: 'CI server (environment)' });
    useEnv();
    expect((await instanceCredential(db as never, 'ci-server'))!.name).toBe('CI server (environment) (2)');
  });

  test('opens the secret from the environment, and never for a Custom request', async () => {
    useEnv();
    const record = (await instanceCredential(db as never, 'ci-server'))!;
    expect(record).toMatchObject({ managedBy: 'env', allProjects: true, user: 'piwi-bot' });
    const use = useOf(record.id, { url: 'https://ci.example.com/job/e2e/build', projectId: 3 });
    expect(await withCredential(db as never, use, async (opened) => opened)).toEqual({
      user: 'piwi-bot',
      secret: 'env-secret',
    });
    await expect(withCredential(db as never, { ...use, custom: true }, async () => 'sent')).rejects.toThrow(
      'does not go with a Custom request',
    );
  });
});

describe('pruneCredentialUses', () => {
  test('deletes the log rows last written before the cutoff, and keeps a counted read written since', async () => {
    const day = 24 * 60 * 60 * 1000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
    const row = (createdAt: Date, lastAt: Date) => ({
      credentialName: 'Team Jenkins',
      feature: 'ci-check',
      result: 'ok',
      createdAt,
      lastAt,
    });
    await db.insert(schema.credentialUses).values([row(at(400), at(400)), row(at(400), at(10)), row(at(5), at(5))]);
    expect(await pruneCredentialUses(db as never, 365)).toBe(1);
    expect((await uses()).map((r) => Math.round((Date.now() - r.lastAt.getTime()) / day))).toEqual([10, 5]);
    expect(await pruneCredentialUses(db as never, 365)).toBe(0);
  });
});

describe('importProjectCiServerTokens', () => {
  const A = 'https://ci-a.example.com/';
  const seal = (url: string, token: string) => encryptSecret(JSON.stringify({ url, token }), SECRET_KEY);
  const jenkins = (id: string, target: Record<string, unknown> = {}) => ({
    id,
    name: id,
    target: { type: 'ci-server', preset: 'jenkins', fields: { job: 'e2e' }, ...target },
    inputs: [],
    accepts: ['tests'],
  });
  const github = {
    id: 'gh',
    name: 'gh',
    target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
    inputs: [],
    accepts: ['tests'],
  };
  const actions = (...list: unknown[]) => ({ enabled: true, actions: list, defaults: {} });

  async function project(id: number, ciServerToken: string, ciRerun: unknown = null) {
    await db.insert(schema.projects).values({ id, name: `p${id}`, ciServerToken, ciRerun: ciRerun as never });
  }
  async function stored(id: number) {
    const [row] = await db
      .select({ ciRerun: schema.projects.ciRerun, ciServerToken: schema.projects.ciServerToken })
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    return row!;
  }
  const targets = async (id: number) =>
    resolveCiActionsSettings((await stored(id)).ciRerun).actions.map(
      (action) => action.target as Record<string, unknown>,
    );
  const openFor = (credentialId: number, projectId: number, url = `${A}job/e2e/buildWithParameters`) =>
    withCredential(
      db as never,
      { ...useOf(credentialId, { projectId, url }), actor: { userId: null, apiKeyId: null } },
      async (opened) => opened,
    );

  test('moves each token into a credential bound to its URL, shared with its projects, named by the actions it served', async () => {
    process.env.PIWI_CI_SERVER_URL = A;
    await project(
      10,
      seal(A, 'shared-token'),
      actions(
        jenkins('served', { baseUrl: A, user: 'team-bot' }),
        jenkins('elsewhere', { baseUrl: 'https://ci-b.example.com/', user: 'team-bot' }),
        github,
      ),
    );
    await project(11, seal(A, 'shared-token'), actions(jenkins('instance', { user: 'team-bot' })));
    await project(
      12,
      seal(A, 'shared-token'),
      actions(jenkins('other-user', { baseUrl: `${A}job/qa/`, user: 'other-bot' })),
    );
    await project(13, seal(A, 'shared-token'));
    await project(14, 'v1:garbage');
    await project(15, seal(A, 'other-token'), actions(jenkins('served', { baseUrl: A, user: 'team-bot' })));

    expect(await importProjectCiServerTokens(db as never)).toBe(5);

    const records = await Promise.all(
      (await db.select({ id: schema.credentials.id }).from(schema.credentials).orderBy(asc(schema.credentials.id))).map(
        async (row) => (await loadCredentialRecord(db as never, row.id))!,
      ),
    );
    expect(
      records.map((r) => ({ name: r.name, user: r.user, projectIds: r.projectIds, destination: r.destination })),
    ).toEqual([
      { name: 'CI server token · ci-a.example.com · team-bot', user: 'team-bot', projectIds: [10, 11], destination: A },
      { name: 'CI server token · ci-a.example.com · other-bot', user: 'other-bot', projectIds: [12], destination: A },
      { name: 'CI server token · ci-a.example.com', user: null, projectIds: [13], destination: A },
      { name: 'CI server token · ci-a.example.com · team-bot (2)', user: 'team-bot', projectIds: [15], destination: A },
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        service: 'ci-server',
        allProjects: false,
        allowedInputs: null,
        customRequests: true,
        disabled: false,
        managedBy: 'db',
      });
    }
    const [teamBot, otherBot, , otherToken] = records.map((r) => r.id);

    const [served, elsewhere, gh] = await targets(10);
    expect(served).toEqual({
      type: 'ci-server',
      preset: 'jenkins',
      baseUrl: A,
      credentialId: teamBot,
      fields: expect.any(Object),
    });
    expect(elsewhere).toMatchObject({ baseUrl: 'https://ci-b.example.com/', user: 'team-bot' });
    expect(elsewhere).not.toHaveProperty('credentialId');
    expect(gh).toEqual(github.target);
    expect(await targets(11)).toEqual([expect.objectContaining({ credentialId: teamBot })]);
    expect((await targets(11))[0]).not.toHaveProperty('user');
    expect(await targets(12)).toEqual([expect.objectContaining({ credentialId: otherBot, baseUrl: `${A}job/qa/` })]);
    expect(await targets(15)).toEqual([expect.objectContaining({ credentialId: otherToken })]);
    expect((await stored(13)).ciRerun).toBeNull();

    for (const id of [10, 11, 12, 13, 15]) expect((await stored(id)).ciServerToken).toBeNull();
    expect((await stored(14)).ciServerToken).toBe('v1:garbage');

    expect(await openFor(teamBot!, 11)).toEqual({ user: 'team-bot', secret: 'shared-token' });
    expect(await openFor(otherToken!, 15)).toEqual({ user: 'team-bot', secret: 'other-token' });
    await expect(openFor(teamBot!, 12)).rejects.toThrow('is not shared with this project');

    expect(await importProjectCiServerTokens(db as never)).toBe(0);
    expect(await db.select({ id: schema.credentials.id }).from(schema.credentials)).toHaveLength(4);
  });

  test('keeps the base URL a served action dispatches under', async () => {
    // A token sealed with the root URL, and an action that sends under the instance's folder.
    process.env.PIWI_CI_SERVER_URL = `${A}job/qa/`;
    await project(20, seal(A, 'shared-token'), actions(jenkins('instance', { user: 'team-bot' })));
    const before = ciServerTargetOf((await targets(20))[0] as never);
    expect(ciServerBaseUrl(before, null)).toBe(`${A}job/qa/`);

    expect(await importProjectCiServerTokens(db as never)).toBe(1);
    const after = ciServerTargetOf((await targets(20))[0] as never);
    expect(after.credentialId).toBeDefined();
    expect(ciServerBaseUrl(after, await ciServerCredential(db as never, after))).toBe(`${A}job/qa/`);
  });

  test('names the credential in the CI server action of a project whose settings predate CI actions', async () => {
    await project(21, seal(A, 'legacy-token'), {
      enabled: true,
      via: 'ci-server',
      ciServer: { preset: 'jenkins', baseUrl: A, user: 'team-bot', rerun: { job: 'e2e' } },
    });
    expect(await importProjectCiServerTokens(db as never)).toBe(1);
    expect((await stored(21)).ciServerToken).toBeNull();
    const [target] = await targets(21);
    expect(target).toMatchObject({ type: 'ci-server', baseUrl: A });
    expect(target!.credentialId).toEqual(expect.any(Number));
  });
});

describe('a secret read from a server variable', () => {
  const VARIABLE = 'PIWI_CREDENTIAL_TEAM_JENKINS';
  const avery = {
    user: { id: 1, username: 'avery', name: null, role: InstanceRole.ADMINISTRATOR } as unknown as User,
    access: ADMIN_ACCESS,
  };
  const quinn = {
    user: { id: 2, username: 'quinn', name: null, role: InstanceRole.MEMBER } as unknown as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.PROJECT_ADMIN }]),
  };
  const call = (handler: Handler, id: number, body?: unknown) => handler({ params: { id: String(id) }, body });

  async function createFromVariable(createdBy: number | null = 1): Promise<number> {
    const input: Omit<CredentialInput, 'secret'> = {
      name: 'Team Jenkins',
      description: null,
      service: 'ci-server',
      user: 'team-bot',
      secretEnv: VARIABLE,
      destination: DEST,
      scope: { allProjects: false, projectIds: [1] },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
    };
    return insertCredential(db as never, input, sealCredentialEnv(DEST, VARIABLE), createdBy);
  }

  afterEach(() => {
    delete process.env[VARIABLE];
  });

  test('is named PIWI_CREDENTIAL_* only, and never beside a typed secret', () => {
    const base = {
      name: 'Team Jenkins',
      service: 'ci-server',
      destination: DEST,
      scope: { allProjects: false, projectIds: [1] },
    };
    expect(parseCredentialInput({ ...base, secretEnv: ` ${VARIABLE} ` }, { partial: false }).value).toMatchObject({
      secretEnv: VARIABLE,
    });
    for (const secretEnv of ['PIWI_SECRET_KEY', 'PIWI_DATABASE_URL', 'PIWI_CREDENTIAL_', 'piwi_credential_x', 'HOME']) {
      expect(parseCredentialInput({ ...base, secretEnv }, { partial: false }).error, secretEnv).toContain(
        'PIWI_CREDENTIAL_',
      );
    }
    expect(parseCredentialInput({ ...base, secretEnv: VARIABLE, secret: 'x' }, { partial: false }).error).toContain(
      'not both',
    );
    expect(parseCredentialInput(base, { partial: false }).error).toContain('the variable it is read from');
  });

  test('is read at each use, and a use while it is unset is refused before anything is sent', async () => {
    const id = await createFromVariable();
    process.env[VARIABLE] = ' env-secret ';
    const opened = await withCredential(db as never, useOf(id), async (credential) => credential);
    expect(opened).toEqual({ user: 'team-bot', secret: 'env-secret' });

    delete process.env[VARIABLE];
    const send = vi.fn();
    await expect(withCredential(db as never, useOf(id), send)).rejects.toThrow(
      `reads its secret from ${VARIABLE}, which is not set on the server`,
    );
    expect(send).not.toHaveBeenCalled();
    expect((await uses()).map((u) => u.result)).toEqual(['ok', 'refused']);
  });

  test('does not open once its row names another variable or destination than it was sealed with', async () => {
    const id = await createFromVariable();
    process.env[VARIABLE] = 'env-secret';
    process.env.PIWI_CREDENTIAL_OTHER = 'other-secret';
    try {
      await db
        .update(schema.credentials)
        .set({ secretEnv: 'PIWI_CREDENTIAL_OTHER' })
        .where(eq(schema.credentials.id, id));
      await expect(withCredential(db as never, useOf(id), async () => 'sent')).rejects.toThrow('cannot be opened');
    } finally {
      delete process.env.PIWI_CREDENTIAL_OTHER;
    }
  });

  test('says whether the variable is set, and nothing for a saved secret', async () => {
    process.env[VARIABLE] = 'env-secret';
    expect(withSecretEnvState({ secretEnv: VARIABLE, secretEnvSet: null })).toEqual({
      secretEnv: VARIABLE,
      secretEnvSet: true,
    });
    delete process.env[VARIABLE];
    expect(withSecretEnvState({ secretEnv: VARIABLE, secretEnvSet: null }).secretEnvSet).toBe(false);
    expect(withSecretEnvState({ secretEnv: null, secretEnvSet: null }).secretEnvSet).toBeNull();
  });

  test('is named by an administrator alone, and a credential that reads one is theirs', async () => {
    const own = await create({ createdBy: 2 });
    state.caller = quinn;
    await expect(call(patchCredential, own, { secretEnv: VARIABLE })).rejects.toMatchObject({ statusCode: 403 });
    expect((await loadCredentialRecord(db as never, own))!.secretEnv).toBeNull();

    state.caller = avery;
    process.env[VARIABLE] = 'env-secret';
    expect((await call(patchCredential, own, { secretEnv: VARIABLE })).credential).toMatchObject({
      secretEnv: VARIABLE,
      secretEnvSet: true,
    });
    const record = (await loadCredentialRecord(db as never, own))!;
    expect(canManageCredential({ access: quinn.access, userId: 2 }, record)).toBe(false);

    await expect(call(patchCredential, own, { destination: 'https://ci.example.com/' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(
      (await call(patchCredential, own, { destination: 'https://ci.example.com/', secretEnv: VARIABLE })).credential,
    ).toMatchObject({ destination: 'https://ci.example.com/', secretEnv: VARIABLE });
    expect((await call(patchCredential, own, { secret: 'typed-again' })).credential).toMatchObject({
      secretEnv: null,
    });
  });
});

describe('the review’s rules', () => {
  const avery = {
    user: { id: 1, username: 'avery', name: null, role: InstanceRole.ADMINISTRATOR } as unknown as User,
    access: ADMIN_ACCESS,
  };
  const quinn = {
    user: { id: 2, username: 'quinn', name: null, role: InstanceRole.MEMBER } as unknown as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.PROJECT_ADMIN }]),
  };
  const call = (handler: Handler, id: number, body?: unknown) => handler({ params: { id: String(id) }, body });
  const posted = {
    name: 'Quinn Jenkins',
    service: 'ci-server',
    secret: 'quinn-secret',
    destination: DEST,
    scope: { allProjects: false, projectIds: [1] },
  };

  test('a change by an administrator makes a Project admin’s credential the administrator’s', async () => {
    const id = await create({ createdBy: 2 });
    state.caller = avery;
    await call(patchCredential, id, { disabled: true });
    expect((await loadCredentialRecord(db as never, id))!.createdBy).toBe(1);
    state.caller = quinn;
    await expect(call(patchCredential, id, { disabled: false, customRequests: true })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await loadCredentialRecord(db as never, id)).toMatchObject({ disabled: true, customRequests: false });
  });

  test('a Project admin creates a credential for the projects they manage, never for all, nor from a variable', async () => {
    state.caller = quinn;
    expect((await createCredentialRoute({ body: posted })).credential).toMatchObject({
      name: 'Quinn Jenkins',
      canManage: true,
      scope: { allProjects: false, projectIds: [1] },
    });
    expect(
      (await loadCredentialRecord(
        db as never,
        (await createCredentialRoute({ body: { ...posted, name: 'Second' } })).credential.id as number,
      ))!.createdBy,
    ).toBe(2);
    await expect(
      createCredentialRoute({ body: { ...posted, name: 'All', scope: { allProjects: true } } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      createCredentialRoute({ body: { ...posted, name: 'Other', scope: { allProjects: false, projectIds: [2] } } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const { secret: _secret, ...withoutSecret } = posted;
    await expect(
      createCredentialRoute({ body: { ...withoutSecret, name: 'Variable', secretEnv: 'PIWI_CREDENTIAL_QUINN' } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(createCredentialRoute({ body: { ...posted, name: 'quinn JENKINS' } })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test('a name is unique ignoring case in the database too', async () => {
    await create({ name: 'Team Jenkins' });
    await expect(create({ name: 'TEAM jenkins' })).rejects.toThrow();
  });

  test('never opens a variable outside PIWI_CREDENTIAL_*, even one sealed for it', async () => {
    const input: Omit<CredentialInput, 'secret'> = {
      name: 'Home',
      description: null,
      service: 'ci-server',
      user: null,
      secretEnv: 'HOME',
      destination: DEST,
      scope: { allProjects: false, projectIds: [1] },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
    };
    const id = await insertCredential(db as never, input, sealCredentialEnv(DEST, 'HOME'), 1);
    const send = vi.fn();
    await expect(withCredential(db as never, useOf(id), send)).rejects.toThrow('cannot be opened');
    expect(send).not.toHaveBeenCalled();
  });

  test('masks the secret in an answer whose JSON escapes it', () => {
    const opened = { user: 'team-bot', secret: 'ab/cd+ef' };
    const answer = maskCredentialAnswer('{"message":"token ab\\/cd+ef rejected","nested":["\\u0061b/cd+ef"]}', opened);
    expect(answer).not.toContain('cd+ef');
    expect(JSON.parse(answer)).toEqual({ message: 'token **** rejected', nested: ['****'] });
    expect(maskCredentialAnswer('plain ab/cd+ef', opened)).toBe('plain ****');
  });

  test('the log of every credential keeps a deleted one’s rows, under its name', async () => {
    const id = await create();
    await withCredential(db as never, useOf(id), async () => 'sent');
    await db.delete(schema.credentials).where(eq(schema.credentials.id, id));
    expect((await listCredentialUses(db as never, id, {})).items).toEqual([]);
    expect((await listCredentialUses(db as never, null, {})).items).toEqual([
      expect.objectContaining({ credentialName: 'Team Jenkins', result: 'ok' }),
    ]);
  });

  test('a save checks only the actions whose credential, base URL or preset changed', async () => {
    const id = await create();
    const action = (over: Record<string, unknown> = {}) => ({
      id: 'nightly',
      name: 'Nightly',
      target: { type: 'ci-server', preset: 'jenkins', credentialId: id, fields: { job: 'e2e' }, ...over },
    });
    await db.update(schema.credentials).set({ allProjects: false }).where(eq(schema.credentials.id, id));
    await db.delete(schema.credentialProjects);
    const refused = 'no CI server credential';
    expect(await ciActionsCredentialProblem(db as never, 1, { actions: [action()] })).toContain(refused);
    expect(await ciActionsCredentialProblem(db as never, 1, { actions: [action()] }, [action()])).toBeNull();
    expect(
      await ciActionsCredentialProblem(db as never, 1, { actions: [action({ baseUrl: DEST })] }, [action()]),
    ).toContain(refused);
  });
});
