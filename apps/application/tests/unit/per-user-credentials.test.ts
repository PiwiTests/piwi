import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import {
  jenkinsRoot,
  parseCredentialInput,
  readWhoAmI,
  userTokenInputProblem,
  userTokenTestUrl,
  type CredentialInput,
} from '#shared/credentials';
import {
  actionUserTokenReadiness,
  canManageCredential,
  deleteCredential,
  insertCredential,
  listMyCredentials,
  listUserTokens,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { claimCiDispatch } from '#shared/handlers/ci-dispatches';
import { ciActionTargetDigest } from '#shared/ci-dispatch-request';
import { openTempDb, type TempDb } from './temp-db';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

/**
 * Per-user credentials: a CI server credential with no secret of its own, for
 * which each person gives their own token, tested before it is saved, sealed
 * with the credential, the person and the destination, and sent only for that
 * person in a session; the readiness a run dialog reads, the repeat guard and
 * the digest of what a dispatch in a person's name sends.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body?: unknown }) => event.body);
vi.stubGlobal('getRouterParam', (event: { params?: Record<string, string> }, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('setResponseHeader', () => {});

const { CredentialRefusedError, recordUserTokenTest, saveUserToken, sealCredentialSecret, withCredential } =
  await import('../../server/utils/credentials');
const { deleteUserRecord } = await import('#shared/handlers/users');
const { dispatchToCiServer, testCiServerUserToken } = await import('../../server/utils/ci-server-dispatch');
const { resolveCiServerTarget } = await import('#shared/ci-server');
type TokenRoute = (event: { params: Record<string, string>; body?: unknown }) => Promise<unknown>;
const putToken = underRoutePermission(
  state,
  (await import('../../server/api/credentials/[id]/token/index.put')).default as unknown as TokenRoute,
);
const { ciServerTemplateValues } = await import('#shared/handlers/ci-rerun-target');

const SECRET_KEY = '0123456789abcdef'.repeat(4);
const DEST = 'https://ci.example.com/';
const TOKEN = '11' + 'a'.repeat(32);

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.PIWI_SECRET_KEY = SECRET_KEY;
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: 2, username: 'quinn', password: '', role: InstanceRole.MEMBER },
    { id: 3, username: 'sam', password: '', role: InstanceRole.MEMBER },
  ]);
  await db.insert(schema.apiKeys).values({ id: 9, userId: 2, name: 'agent', keyHash: 'hash', keyPrefix: 'agent' });
});

afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});

beforeEach(async () => {
  await db.delete(schema.ciDispatches);
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
  await db.delete(schema.projects);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin' },
  ]);
});

/** A per-user CI server credential shared with project 1. */
async function createPerUser(over: Partial<Omit<CredentialInput, 'secret'>> = {}): Promise<number> {
  return insertCredential(
    db as never,
    {
      name: 'Jenkins in your name',
      description: null,
      service: 'ci-server',
      user: null,
      destination: DEST,
      scope: { allProjects: false, projectIds: [1] },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
      perUser: true,
      tokenHelpUrl: null,
      ...over,
    },
    null,
    1,
  );
}

/** Save a person's tested token, as the token route does once the test named their account. */
async function give(credentialId: number, userId: number, remoteUser: string, secret = TOKEN, destination = DEST) {
  return saveUserToken(db as never, { credentialId, userId, destination, remoteUser }, { user: remoteUser, secret });
}

/** A dispatch of project 1's `nightly` action, by a person in a session. */
const useOf = (credentialId: number, userId: number | null, over: Record<string, unknown> = {}) => ({
  credentialId,
  feature: 'ci-dispatch' as const,
  projectId: 1,
  url: `${DEST}job/nightly/buildWithParameters`,
  custom: false,
  actor: { userId, apiKeyId: null },
  subject: { type: 'ci-action', id: 'nightly' },
  ...over,
});

const uses = () => db.select().from(schema.credentialUses).orderBy(asc(schema.credentialUses.id));

async function refusal(run: Promise<unknown>) {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CredentialRefusedError);
  return error as InstanceType<typeof CredentialRefusedError>;
}

describe('a posted per-user credential', () => {
  const base = {
    name: 'Jenkins in your name',
    service: 'ci-server',
    destination: DEST,
    scope: { allProjects: true },
    perUser: true,
  };

  test('is a CI server credential created without a user or a secret', () => {
    const parsed = parseCredentialInput(base, { partial: false });
    expect(parsed.error).toBeNull();
    expect(parsed.value).toMatchObject({ perUser: true, service: 'ci-server' });
    expect(parsed.value).not.toHaveProperty('secret');
  });

  test('refuses a user, a secret, a variable or a Custom request', () => {
    for (const extra of [
      { user: 'bot' },
      { secret: 'x' },
      { secretEnv: 'PIWI_CREDENTIAL_X' },
      { customRequests: true },
    ]) {
      expect(parseCredentialInput({ ...base, ...extra }, { partial: false }).error).not.toBeNull();
    }
  });

  test('is a CI server credential only, and is never made per-user by an update', () => {
    expect(parseCredentialInput({ ...base, service: 'scm' }, { partial: false }).error).toMatch(/CI server/);
    expect(parseCredentialInput({ perUser: true }, { partial: true }).error).toMatch(/creation/);
  });

  test('takes an http(s) link to where a person creates their token', () => {
    expect(
      parseCredentialInput({ ...base, tokenHelpUrl: 'https://ci.example.com/me/security/' }, { partial: false }).value,
    ).toMatchObject({ tokenHelpUrl: 'https://ci.example.com/me/security/' });
    expect(
      parseCredentialInput({ ...base, tokenHelpUrl: 'javascript:alert(1)' }, { partial: false }).error,
    ).not.toBeNull();
  });
});

describe('a user token as typed', () => {
  test('is a user name and a Jenkins API token, never a password', () => {
    expect(userTokenInputProblem('alice', TOKEN)).toBeNull();
    expect(userTokenInputProblem('alice', 'b'.repeat(32))).toBeNull();
    expect(userTokenInputProblem('alice', 'correct horse battery staple')).toMatch(/not a password/);
    expect(userTokenInputProblem('alice', '12' + 'a'.repeat(32))).toMatch(/not a password/);
    expect(userTokenInputProblem('', TOKEN)).toMatch(/user name/);
    expect(userTokenInputProblem('ali\nce', TOKEN)).toMatch(/line break/);
  });

  test('is tested at Jenkins’ root, a destination narrowed to a folder included', () => {
    expect(jenkinsRoot('https://ci.example.com/job/tests/job/e2e/')).toBe('https://ci.example.com/');
    expect(jenkinsRoot('https://ci.example.com/jenkins/job/tests/')).toBe('https://ci.example.com/jenkins/');
    expect(userTokenTestUrl('https://ci.example.com/jenkins/')).toBe('https://ci.example.com/jenkins/whoAmI/api/json');
  });

  test('names the account a whoAmI answer names, and never an anonymous one', () => {
    expect(readWhoAmI({ name: 'alice', authenticated: true, anonymous: false })).toEqual({
      ok: true,
      remoteUser: 'alice',
    });
    expect(readWhoAmI({ name: 'anonymous', authenticated: true, anonymous: true })).toEqual({
      ok: false,
      reason: 'anonymous',
    });
    expect(readWhoAmI({ name: 'alice', authenticated: false })).toEqual({ ok: false, reason: 'anonymous' });
    expect(readWhoAmI(null)).toEqual({ ok: false, reason: 'anonymous' });
  });
});

describe('withCredential and a per-user credential', () => {
  test('sends the token of the person who started the use, and logs their account', async () => {
    const id = await createPerUser();
    expect(await give(id, 2, 'quinn.qa')).toEqual({ saved: true });
    const opened = await withCredential(db as never, useOf(id, 2), async (o) => o);
    expect(opened).toEqual({ user: 'quinn.qa', secret: TOKEN });
    expect(await uses()).toEqual([
      expect.objectContaining({ credentialId: id, userId: 2, remoteUser: 'quinn.qa', result: 'ok' }),
    ]);
    const [token] = await listUserTokens(db as never, id);
    expect(token).toMatchObject({ userId: 2, remoteUser: 'quinn.qa', state: 'ready' });
    expect(token!.lastUsedAt).not.toBeNull();
  });

  test('never sends another person’s token: a person without one is asked for theirs', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    let sent = false;
    const error = await refusal(
      withCredential(db as never, useOf(id, 3), async () => {
        sent = true;
      }),
    );
    expect(sent).toBe(false);
    expect(error.code).toBe('user-token-required');
    expect(error.credential).toEqual({ id, name: 'Jenkins in your name' });
    expect(await uses()).toEqual([expect.objectContaining({ userId: 3, result: 'refused' })]);
  });

  test('is refused to an API key and without a person, before anything is sent', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    const byKey = await refusal(
      withCredential(db as never, useOf(id, 2, { actor: { userId: 2, apiKeyId: 9 } }), async () => 'sent'),
    );
    expect(byKey.code).toBe('session-required');
    const nobody = await refusal(withCredential(db as never, useOf(id, null), async () => 'sent'));
    expect(nobody.code).toBe('sign-in-required');
  });

  test('does not open a token row copied to another person', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    await give(id, 3, 'sam.qa', 'c'.repeat(32));
    const [quinn] = await db
      .select({ secret: schema.credentialUserTokens.secret })
      .from(schema.credentialUserTokens)
      .where(eq(schema.credentialUserTokens.userId, 2));
    await db
      .update(schema.credentialUserTokens)
      .set({ secret: quinn!.secret })
      .where(eq(schema.credentialUserTokens.userId, 3));
    const error = await refusal(withCredential(db as never, useOf(id, 3), async () => 'sent'));
    expect(error.code).toBe('user-token-required');
  });

  test('does not open a token row copied to another credential, nor once its destination changed, and asks again', async () => {
    const id = await createPerUser();
    const other = await createPerUser({ name: 'Other Jenkins' });
    await give(id, 2, 'quinn.qa');
    await give(other, 2, 'quinn.qa', 'c'.repeat(32));
    const sealedOf = async (credentialId: number) =>
      (
        await db
          .select({ secret: schema.credentialUserTokens.secret })
          .from(schema.credentialUserTokens)
          .where(eq(schema.credentialUserTokens.credentialId, credentialId))
      )[0]!.secret;
    await db
      .update(schema.credentialUserTokens)
      .set({ secret: await sealedOf(id) })
      .where(eq(schema.credentialUserTokens.credentialId, other));
    expect((await refusal(withCredential(db as never, useOf(other, 2), async () => 'sent'))).code).toBe(
      'user-token-required',
    );
    expect((await listUserTokens(db as never, other))[0]!.state).toBe('invalid');
    await db
      .update(schema.credentials)
      .set({ destination: 'https://ci.example.com/job/' })
      .where(eq(schema.credentials.id, id));
    await refusal(
      withCredential(db as never, useOf(id, 2, { url: 'https://ci.example.com/job/x/build' }), async () => 'sent'),
    );
    expect((await listUserTokens(db as never, id))[0]!.state).toBe('invalid');
  });

  test('sends a typed token only to test it, and only for a per-user credential', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    const typed = { candidate: { user: 'quinn.qa', secret: 'd'.repeat(32) } };
    expect((await refusal(withCredential(db as never, useOf(id, 2, typed), async () => 'sent'))).message).toMatch(
      /only to test/,
    );
    const shared = await insertCredential(
      db as never,
      {
        name: 'Shared Jenkins',
        description: null,
        service: 'ci-server',
        user: 'bot',
        destination: DEST,
        scope: { allProjects: true },
        allowedInputs: null,
        customRequests: false,
        disabled: false,
      },
      sealCredentialSecret(DEST, 'shared-secret'),
      1,
    );
    await refusal(
      withCredential(
        db as never,
        { ...useOf(shared, 2, typed), feature: 'credential-test', url: userTokenTestUrl(DEST) },
        async () => 'sent',
      ),
    );
  });

  test('a refusal of a token saved since leaves the new one ready', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    await withCredential(
      db as never,
      useOf(id, 2),
      async () => {
        // The person gives their token again while the old one is on its way.
        await give(id, 2, 'quinn.qa', 'e'.repeat(32));
        return { status: 401 };
      },
      () => 'The CI server answered 401',
      { unauthorized: (answer) => answer.status === 401 },
    );
    expect((await listUserTokens(db as never, id))[0]!.state).toBe('ready');
    const startedAt = new Date(Date.now() - 60_000);
    await recordUserTokenTest(db as never, { credentialId: id, userId: 2 }, 'invalid', startedAt);
    expect((await listUserTokens(db as never, id))[0]!.state).toBe('ready');
  });

  test('marks a token the service refused invalid, and sends it no more until a test takes it again', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    await withCredential(
      db as never,
      useOf(id, 2),
      async () => ({ status: 401 }),
      () => 'The CI server answered 401',
      {
        unauthorized: (answer) => answer.status === 401,
      },
    );
    expect((await listUserTokens(db as never, id))[0]!.state).toBe('invalid');
    const error = await refusal(withCredential(db as never, useOf(id, 2), async () => 'sent'));
    expect(error.message).toMatch(/was refused/);
    // A test sends the refused token again, to see whether it is taken.
    const tested = await withCredential(
      db as never,
      useOf(id, 2, { feature: 'credential-test', projectId: null, url: userTokenTestUrl(DEST), subject: undefined }),
      async (o) => o.secret,
    );
    expect(tested).toBe(TOKEN);
    await recordUserTokenTest(db as never, { credentialId: id, userId: 2 }, 'ready', new Date());
    expect((await listUserTokens(db as never, id))[0]!.state).toBe('ready');
  });

  test('tests a token not saved yet at the one test URL alone, whatever the project and a folder destination', async () => {
    const folder = 'https://ci.example.com/job/tests/';
    const id = await createPerUser({ destination: folder });
    const test = (url: string) =>
      withCredential(
        db as never,
        {
          credentialId: id,
          feature: 'credential-test',
          projectId: null,
          url,
          custom: false,
          actor: { userId: 2, apiKeyId: null },
          candidate: { user: 'quinn.qa', secret: TOKEN },
        },
        async (o) => o,
      );
    expect(await test('https://ci.example.com/whoAmI/api/json')).toEqual({ user: 'quinn.qa', secret: TOKEN });
    await refusal(test('https://ci.example.com/job/tests/job/e2e/build'));
    // A dispatch never carries a typed token: only a test does, and only for a per-user credential.
    await refusal(
      withCredential(
        db as never,
        { ...useOf(id, 2), feature: 'credential-test', url: 'https://ci.example.com/whoAmI/api/json' },
        async () => 'sent',
      ),
    );
  });

  test('counts each person’s reads in rows of their own', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    await give(id, 3, 'sam.qa', 'c'.repeat(32));
    for (const userId of [2, 3, 2]) {
      await withCredential(db as never, useOf(id, userId, { feature: 'ci-check' }), async () => 'read');
    }
    const rows = await uses();
    expect(rows.map((r) => [r.userId, r.remoteUser, r.count])).toEqual([
      [2, 'quinn.qa', 2],
      [3, 'sam.qa', 1],
    ]);
  });
});

describe('saving a user token', () => {
  test('replaces the person’s own, and refuses an account another person gave', async () => {
    const id = await createPerUser();
    expect(await give(id, 2, 'quinn.qa')).toEqual({ saved: true });
    expect(await give(id, 2, 'quinn.qa', 'd'.repeat(32))).toEqual({ saved: true });
    expect(await listUserTokens(db as never, id)).toHaveLength(1);
    expect(await give(id, 3, 'Quinn.QA')).toEqual({ saved: false, message: expect.stringMatching(/each person/) });
  });

  test('is gone with its credential and with its person', async () => {
    const id = await createPerUser();
    await give(id, 2, 'quinn.qa');
    await give(id, 3, 'sam.qa', 'c'.repeat(32));
    await db.insert(schema.users).values({ id: 4, username: 'leaving', password: '', role: InstanceRole.MEMBER });
    await give(id, 4, 'leaving.qa', 'd'.repeat(32));
    await deleteUserRecord(db as never, 4);
    expect((await listUserTokens(db as never, id)).map((t) => t.userId)).toEqual([2, 3]);
    await deleteCredential(db as never, id);
    expect(await db.select({ id: schema.credentialUserTokens.id }).from(schema.credentialUserTokens)).toEqual([]);
  });

  test('is refused when its credential moved while it was tested', async () => {
    const id = await createPerUser();
    await db
      .update(schema.credentials)
      .set({ destination: 'https://other.example.com/' })
      .where(eq(schema.credentials.id, id));
    expect(await give(id, 2, 'quinn.qa')).toEqual({ saved: false, message: expect.stringMatching(/changed/) });
  });

  test('refuses an account another person saved at the same moment, through the account’s unique index', async () => {
    const id = await createPerUser();
    await db.insert(schema.credentialUserTokens).values({
      credentialId: id,
      userId: 3,
      remoteUser: 'QUINN.qa',
      secret: 'sealed',
      state: 'ready',
    });
    await expect(
      db.insert(schema.credentialUserTokens).values({
        credentialId: id,
        userId: 2,
        remoteUser: 'quinn.qa',
        secret: 'sealed',
        state: 'ready',
      }),
    ).rejects.toThrow();
  });
});

describe('who sees and manages a per-user credential', () => {
  const projectAdmin = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.PROJECT_ADMIN }]);
  const runner = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]);
  const reader = buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 2, role: ProjectRole.VIEWER }]);

  test('only credentials:manage changes it, even its creator a Project admin', async () => {
    const id = await createPerUser();
    const record = (await loadCredentialRecord(db as never, id))!;
    expect(canManageCredential({ access: projectAdmin, userId: 1 }, { ...record, createdBy: 1 })).toBe(false);
    const administrator = buildAccessSummary(InstanceRole.ADMINISTRATOR, []);
    expect(canManageCredential({ access: administrator, userId: 9 }, record)).toBe(true);
  });

  test('a person’s Account lists it when they run CI where it is shared, or hold a token for it', async () => {
    const id = await createPerUser();
    expect((await listMyCredentials(db as never, { access: runner, userId: 2 })).map((e) => [e.id, e.usable])).toEqual([
      [id, true],
    ]);
    expect(await listMyCredentials(db as never, { access: reader, userId: 3 })).toEqual([]);
    await give(id, 3, 'sam.qa');
    const [held] = await listMyCredentials(db as never, { access: reader, userId: 3 });
    expect(held).toMatchObject({ id, usable: false, token: { remoteUser: 'sam.qa', state: 'ready' } });
    expect(held!.token).not.toHaveProperty('secret');
  });
});

describe('the readiness of an action on a per-user credential', () => {
  test('asks a person for their token, and refuses an API key or no sign-in', async () => {
    const id = await createPerUser();
    const ready = (userId: number | null, apiKeyId: number | null = null) =>
      actionUserTokenReadiness(db as never, { credentialId: id }, { userId, apiKeyId });
    expect(await ready(2)).toMatchObject({ code: 'user-token-required', perUser: { userToken: 'missing' } });
    await give(id, 2, 'quinn.qa');
    expect(await ready(2)).toEqual({
      perUser: { credential: { id, name: 'Jenkins in your name', account: 'quinn.qa' }, userToken: 'ready' },
      reason: null,
    });
    expect(await ready(2, 5)).toMatchObject({ code: 'session-required', perUser: { userToken: null } });
    expect(await ready(null)).toMatchObject({ code: 'sign-in-required' });
    expect(
      await actionUserTokenReadiness(db as never, { credentialId: null }, { userId: 2, apiKeyId: null }),
    ).toBeNull();
  });
});

describe('a dispatch in a person’s name', () => {
  test('repeats only the same person’s dispatch', async () => {
    const row = (id: string, byUserId: number) => ({
      id,
      projectId: 1,
      actionId: 'nightly',
      actionName: 'Nightly',
      origin: 'page',
      kind: 'suite',
      provider: 'ci-server',
      args: '',
      inputs: {},
      byUserId,
      byName: `user ${byUserId}`,
    });
    const now = new Date();
    expect(await claimCiDispatch(db as never, row('a'.repeat(16), 2) as never, now, { perPerson: true })).toEqual({
      claimed: true,
    });
    expect(await claimCiDispatch(db as never, row('b'.repeat(16), 3) as never, now, { perPerson: true })).toEqual({
      claimed: true,
    });
    expect(await claimCiDispatch(db as never, row('c'.repeat(16), 2) as never, now, { perPerson: true })).toMatchObject(
      {
        claimed: false,
      },
    );
  });

  test('carries the digest of its action, which another job or input changes', () => {
    const action = {
      target: { type: 'ci-server', preset: 'jenkins', credentialId: 1, fields: { job: 'api/nightly' } },
      inputs: [],
    } as never;
    const digest = ciActionTargetDigest(action);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ciActionTargetDigest(action)).toBe(digest);
    expect(
      ciActionTargetDigest({
        target: { type: 'ci-server', preset: 'jenkins', credentialId: 1, fields: { job: 'prod/deploy' } },
        inputs: [],
      } as never),
    ).not.toBe(digest);
    expect(
      ciActionTargetDigest({
        target: { type: 'ci-server', preset: 'jenkins', credentialId: 1, fields: { job: 'api/nightly' } },
        inputs: [{ name: 'DEPLOY', kind: 'fixed', value: '1' }],
      } as never),
    ).not.toBe(digest);
  });
});

describe('the routes of a person’s own tokens', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

  test('refuse an API key: each takes a signed-in session', () => {
    expect(read('server/utils/user-tokens.ts')).toMatch(/await requireSessionAuth\(event\)/);
    expect(read('server/api/credentials/mine.get.ts')).toMatch(/await requireSessionAuth\(event\)/);
    for (const route of ['index.put.ts', 'index.delete.ts', 'test.post.ts']) {
      expect(read(`server/api/credentials/[id]/token/${route}`), route).toMatch(/await requireUserTokenRoute\(event\)/);
    }
  });
});

describe('a per-user credential against a Jenkins', () => {
  let server: Server;
  let base: string;
  /** The Basic pair of each request, and its path. */
  const seen: Array<{ path: string; auth: string | null }> = [];
  /** The tokens the fake Jenkins takes, by user name; any other answers 401. */
  const accounts: Record<string, string> = { 'quinn.qa': TOKEN };
  let anonymous = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const header = req.headers.authorization ?? null;
      seen.push({ path: req.url ?? '', auth: header });
      const [user, secret] = header?.startsWith('Basic ')
        ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')
        : [];
      if (!user || accounts[user] !== secret) {
        res.writeHead(401);
        res.end('Unauthorized: no such token');
        return;
      }
      if (req.url === '/whoAmI/api/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            anonymous
              ? { name: 'anonymous', anonymous: true, authenticated: true }
              : { name: user, anonymous: false, authenticated: true },
          ),
        );
        return;
      }
      res.writeHead(201, { Location: `${base}queue/item/7/` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    process.env.PIWI_CI_SERVER_HOSTS = '127.0.0.1';
    seen.length = 0;
    anonymous = false;
  });
  afterEach(() => {
    delete process.env.PIWI_CI_SERVER_HOSTS;
  });

  const actor = (userId: number) => ({ userId, apiKeyId: null });

  test('tests a typed token at whoAmI, naming the account, a refusal or an anonymous answer, never Jenkins’ text', async () => {
    const id = await createPerUser({ destination: base });
    const record = { id, destination: base };
    expect(await testCiServerUserToken(db as never, record, actor(2), { user: 'quinn.qa', secret: TOKEN })).toEqual({
      ok: true,
      remoteUser: 'quinn.qa',
    });
    expect(seen.at(-1)).toEqual({
      path: '/whoAmI/api/json',
      auth: `Basic ${Buffer.from(`quinn.qa:${TOKEN}`).toString('base64')}`,
    });
    expect(
      await testCiServerUserToken(db as never, record, actor(2), { user: 'quinn.qa', secret: 'b'.repeat(32) }),
    ).toEqual({ ok: false, reason: 'refused' });
    anonymous = true;
    expect(await testCiServerUserToken(db as never, record, actor(2), { user: 'quinn.qa', secret: TOKEN })).toEqual({
      ok: false,
      reason: 'anonymous',
    });
    const rows = await uses();
    expect(rows.map((r) => r.result)).toEqual(['ok', 'failed']);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  test('never sends a token over http to a host the operator did not list', async () => {
    delete process.env.PIWI_CI_SERVER_HOSTS;
    const id = await createPerUser({ destination: base });
    await expect(
      testCiServerUserToken(db as never, { id, destination: base }, actor(2), { user: 'quinn.qa', secret: TOKEN }),
    ).rejects.toBeInstanceOf(CredentialRefusedError);
    expect(seen).toEqual([]);
  });

  test('dispatches with the starter’s own token, and a 401 marks it refused', async () => {
    const id = await createPerUser({ destination: base });
    await give(id, 2, 'quinn.qa', TOKEN, base);
    await give(id, 3, 'sam.qa', 'c'.repeat(32), base);
    const target = resolveCiServerTarget({ preset: 'jenkins', credentialId: id, rerun: { job: 'nightly' } })!;
    const values = ciServerTemplateValues(target, '--grep x', 'a'.repeat(16), null, null);
    const sent = await dispatchToCiServer(db as never, 1, target, 'rerun', values, {}, { actor: actor(2) });
    expect(sent.url).toContain('/job/nightly/');
    expect(seen.at(-1)!.auth).toBe(`Basic ${Buffer.from(`quinn.qa:${TOKEN}`).toString('base64')}`);
    await expect(dispatchToCiServer(db as never, 1, target, 'rerun', values, {}, { actor: actor(3) })).rejects.toThrow(
      /401/,
    );
    const tokens = await listUserTokens(db as never, id);
    expect(tokens.map((t) => [t.userId, t.state])).toEqual([
      [2, 'ready'],
      [3, 'invalid'],
    ]);
  });
});

describe('giving a token through its route', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const ok = req.headers.authorization === `Basic ${Buffer.from(`quinn.qa:${TOKEN}`).toString('base64')}`;
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(ok ? JSON.stringify({ name: 'quinn.qa', authenticated: true, anonymous: false }) : 'denied');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    process.env.PIWI_CI_SERVER_HOSTS = '127.0.0.1';
  });
  afterEach(() => {
    delete process.env.PIWI_CI_SERVER_HOSTS;
    state.caller = null;
  });

  const runner = (id: number, apiKey = false) => ({
    user: { id, username: `user${id}`, role: 'member' } as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]),
    apiKey,
  });
  async function put(id: number, body: unknown) {
    try {
      return { status: 200, body: await putToken({ params: { id: String(id) }, body }) };
    } catch (e) {
      const error = e as { statusCode: number; message: string; data?: unknown };
      return { status: error.statusCode, body: { message: error.message, data: error.data } };
    }
  }

  test('saves a token Jenkins takes, and answers why it did not take another, with nothing of its text', async () => {
    const id = await createPerUser({ destination: base });
    state.caller = runner(2);
    expect(await put(id, { user: 'quinn.qa', secret: 'b'.repeat(32) })).toMatchObject({
      status: 400,
      body: { data: { reason: 'refused' }, message: expect.not.stringContaining('denied') },
    });
    expect(await put(id, { user: 'quinn.qa', secret: TOKEN })).toMatchObject({
      status: 200,
      body: { credential: { id, token: { remoteUser: 'quinn.qa', state: 'ready' } } },
    });
  });

  test('refuses an API key, a password, a credential the person may not use, and an account someone else gave', async () => {
    const id = await createPerUser({ destination: base });
    state.caller = runner(2, true);
    expect(await put(id, { user: 'quinn.qa', secret: TOKEN })).toMatchObject({ status: 403 });
    state.caller = runner(2);
    expect(await put(id, { user: 'quinn.qa', secret: 'my password' })).toMatchObject({ status: 400 });
    state.caller = {
      ...runner(2),
      access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 2, role: ProjectRole.MAINTAINER }]),
    };
    expect(await put(id, { user: 'quinn.qa', secret: TOKEN })).toMatchObject({ status: 404 });
    await give(id, 3, 'quinn.qa', TOKEN, base);
    state.caller = runner(2);
    expect(await put(id, { user: 'quinn.qa', secret: TOKEN })).toMatchObject({ status: 409 });
  });
});
