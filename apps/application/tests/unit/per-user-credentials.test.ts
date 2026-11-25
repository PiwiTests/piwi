import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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
  insertCredential,
  listMyCredentials,
  listUserTokens,
  loadCredentialRecord,
} from '#shared/handlers/credentials';
import { claimCiDispatch } from '#shared/handlers/ci-dispatches';
import { ciActionTargetDigest } from '#shared/ci-dispatch-request';
import { openTempDb, type TempDb } from './temp-db';

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

const { CredentialRefusedError, recordUserTokenTest, saveUserToken, withCredential } =
  await import('../../server/utils/credentials');

const SECRET_KEY = '0123456789abcdef'.repeat(4);
const DEST = 'https://ci.example.com/';
const TOKEN = '11' + 'a'.repeat(32);

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.PIWI_SECRET_KEY = SECRET_KEY;
  ({ db, close } = await openTempDb());
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
    await recordUserTokenTest(db as never, { credentialId: id, userId: 2 }, 'ready');
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
    await db.delete(schema.credentials).where(eq(schema.credentials.id, id));
    expect(await db.select().from(schema.credentialUserTokens)).toEqual([]);
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
      perUser: { credential: { id, name: 'Jenkins in your name' }, userToken: 'ready' },
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
