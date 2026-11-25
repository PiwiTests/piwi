import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { InstanceRole } from '#shared/permissions';
import { parseCredentialInput } from '#shared/credentials';
import { oauthEndpoints } from '#shared/scm-urls';
import {
  insertCredential,
  listUserTokens,
  loadCredentialRecord,
  projectScmCredentialProblem,
} from '#shared/handlers/credentials';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Per-user source control credentials: the OAuth application an administrator
 * names, each person's authorization at GitLab or Bitbucket (the single-use
 * state, PKCE, the code exchange, the token tested and saved), the refresh of
 * a token as it opens, never in a write gate, and its revocation, against a
 * host played by a stubbed `fetch`.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const { sealCredentialSecret, withCredential, revokeUserTokens, CredentialRefusedError } =
  await import('../../server/utils/credentials');
const { startUserAuthorization, finishUserAuthorization } = await import('../../server/utils/credential-oauth');

const GITLAB = 'https://gitlab.com/';
const BITBUCKET = 'https://api.bitbucket.org/';
const REDIRECT = 'https://piwi.example.com/api/credentials/oauth/callback';

/** What the stubbed host was asked, and what it answers. */
const host = {
  calls: [] as Array<{ url: string; body: URLSearchParams | null; auth: string | null }>,
  /** The token endpoint's answer for a grant type, or a status to refuse with. */
  grant: (params: URLSearchParams): { status: number; json: unknown } => ({
    status: 200,
    json: {
      access_token: `access-${params.get('grant_type')}-${host.calls.length}`,
      refresh_token: `refresh-${host.calls.length}`,
      expires_in: 7200,
    },
  }),
  user: { status: 200, json: { username: 'alice' } as unknown },
};

vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers);
  const body = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
  host.calls.push({ url, body, auth: headers.get('authorization') });
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/oauth/token') || url.endsWith('/oauth2/access_token')) {
    const answer = host.grant(body!);
    return json(answer.status, answer.json);
  }
  if (url.endsWith('/api/v4/user') || url.endsWith('/2.0/user')) return json(host.user.status, host.user.json);
  if (url.endsWith('/oauth/revoke')) return json(200, {});
  return json(404, {});
});

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.PIWI_SECRET_KEY = '0123456789abcdef'.repeat(4);
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: 2, username: 'alice', password: '', role: InstanceRole.MEMBER },
    { id: 3, username: 'mallory', password: '', role: InstanceRole.MEMBER },
  ]);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
});

afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});

beforeEach(async () => {
  host.calls.length = 0;
  host.user = { status: 200, json: { username: 'alice' } };
  host.grant = (params) => ({
    status: 200,
    json: {
      access_token: `access-${params.get('grant_type')}-${host.calls.length}`,
      refresh_token: `refresh-${host.calls.length}`,
      expires_in: 7200,
    },
  });
  await db.delete(schema.credentialAuthorizations);
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
});

/** A per-user source control credential, its OAuth client secret sealed with the host's token endpoint. */
async function createOauth(destination = GITLAB): Promise<number> {
  const endpoints = oauthEndpoints(destination)!;
  return insertCredential(
    db as never,
    {
      name: `${oauthEndpoints(destination)!.label} in your name`,
      description: null,
      service: 'scm',
      user: null,
      destination,
      scope: { allProjects: false, projectIds: [1] },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
      perUser: true,
      tokenHelpUrl: null,
      oauthClientId: 'client-1',
    },
    sealCredentialSecret(endpoints.token, 'client-secret'),
    1,
  );
}

/** A person's authorization, from its start to the host sending them back with a code. */
async function authorize(id: number, userId = 2, as = userId) {
  const record = (await loadCredentialRecord(db as never, id))!;
  const url = new URL(
    await startUserAuthorization(db as never, record, userId, { redirectUri: REDIRECT, returnTo: '/x' }),
  );
  const state = url.searchParams.get('state')!;
  return {
    url,
    outcome: await finishUserAuthorization(db as never, as, {
      state,
      code: 'the-code',
      error: null,
      redirectUri: REDIRECT,
    }),
    state,
  };
}

const useOf = (credentialId: number, userId: number) => ({
  credentialId,
  feature: 'scm-read' as const,
  projectId: 1,
  url: 'https://gitlab.com/api/v4/projects/acme%2Fshop',
  custom: false,
  actor: { userId, apiKeyId: null },
});

describe('the OAuth endpoints of a destination', () => {
  test('are GitLab’s on its host, Bitbucket’s on its site, and none for GitHub', () => {
    expect(oauthEndpoints(GITLAB)).toMatchObject({
      host: 'gitlab',
      authorize: 'https://gitlab.com/oauth/authorize',
      token: 'https://gitlab.com/oauth/token',
      user: 'https://gitlab.com/api/v4/user',
      pkce: true,
    });
    expect(oauthEndpoints('https://git.acme.dev/', new Set(['git.acme.dev']))?.token).toBe(
      'https://git.acme.dev/oauth/token',
    );
    expect(oauthEndpoints(BITBUCKET)).toMatchObject({ host: 'bitbucket', revoke: null, pkce: false });
    expect(oauthEndpoints('https://api.github.com/')).toBeNull();
  });

  test('a posted per-user source control credential names its OAuth application', () => {
    const base = { name: 'x', service: 'scm', destination: GITLAB, scope: { allProjects: true }, perUser: true };
    expect(parseCredentialInput({ ...base, oauthClientId: 'c', secret: 's' }, { partial: false }).error).toBeNull();
    expect(parseCredentialInput({ ...base, secret: 's' }, { partial: false }).error).toMatch(/client id/);
    expect(parseCredentialInput({ ...base, oauthClientId: 'c' }, { partial: false }).error).toMatch(/client id/);
  });
});

describe('a person’s authorization', () => {
  test('sends them to the host with a single-use state and, on GitLab, a PKCE challenge the exchange answers', async () => {
    const id = await createOauth();
    const { url, outcome } = await authorize(id);
    expect(url.origin + url.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'api',
      code_challenge_method: 'S256',
    });
    expect(outcome).toEqual({ ok: true, credentialId: id, returnTo: '/x', message: null });
    const exchange = host.calls.find((c) => c.url === 'https://gitlab.com/oauth/token')!;
    expect(exchange.body?.get('code')).toBe('the-code');
    expect(exchange.body?.get('client_secret')).toBe('client-secret');
    const verifier = exchange.body!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    const [token] = await listUserTokens(db as never, id);
    expect(token).toMatchObject({ userId: 2, remoteUser: 'alice', state: 'ready' });
    expect(await db.select().from(schema.credentialAuthorizations)).toEqual([]);
  });

  test('is refused to another person’s session, and the state is gone with the refusal', async () => {
    const id = await createOauth();
    const { outcome, state } = await authorize(id, 2, 3);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/someone else/) });
    expect(host.calls).toEqual([]);
    const again = await finishUserAuthorization(db as never, 2, {
      state,
      code: 'the-code',
      error: null,
      redirectUri: REDIRECT,
    });
    expect(again).toMatchObject({ ok: false, message: expect.stringMatching(/expired or was already used/) });
    expect(await listUserTokens(db as never, id)).toEqual([]);
  });

  test('saves nothing when the host refuses the code, says only that, and sends Bitbucket its client in a header', async () => {
    const id = await createOauth(BITBUCKET);
    host.grant = () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'secret detail' } });
    const { url, outcome } = await authorize(id);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(outcome).toMatchObject({ ok: false, message: 'Bitbucket refused the authorization: start it again.' });
    const exchange = host.calls.find((c) => c.url.endsWith('/oauth2/access_token'))!;
    expect(exchange.auth).toBe(`Basic ${Buffer.from('client-1:client-secret').toString('base64')}`);
    expect(exchange.body?.has('client_secret')).toBe(false);
    expect(await listUserTokens(db as never, id)).toEqual([]);
  });
});

describe('a person’s OAuth token in use', () => {
  async function expiring(id: number) {
    await authorize(id);
    // The token the host answered expires within the refresh margin.
    const [row] = await db.select().from(schema.credentialUserTokens);
    const record = (await loadCredentialRecord(db as never, id))!;
    const { sealUserToken } = await import('../../server/utils/credentials');
    await db
      .update(schema.credentialUserTokens)
      .set({
        secret: sealUserToken(
          { credentialId: id, userId: 2, destination: record.destination },
          { user: null, secret: 'old-access', refresh: 'old-refresh', expiresAt: Date.now() + 60_000 },
        ),
      })
      .where(eq(schema.credentialUserTokens.id, row!.id));
    host.calls.length = 0;
  }

  test('is refreshed as it opens near its expiry, and the new token is the person’s', async () => {
    const id = await createOauth();
    await expiring(id);
    const sent = await withCredential(db as never, useOf(id, 2), async (opened) => opened.secret);
    expect(sent).toMatch(/^access-refresh_token-/);
    expect(host.calls[0]!.body?.get('refresh_token')).toBe('old-refresh');
    expect(await withCredential(db as never, useOf(id, 2), async (opened) => opened.secret)).toBe(sent);
    expect(host.calls).toHaveLength(1);
  });

  test('is never refreshed in a write gate, where the provider holds the token already opened', async () => {
    const id = await createOauth();
    await expiring(id);
    const sent = await withCredential(db as never, useOf(id, 2), async (opened) => opened.secret, undefined, {
      refresh: false,
    });
    expect(sent).toBe('old-access');
    expect(host.calls).toEqual([]);
  });

  test('is marked refused when the host refuses the refresh, and asked for again', async () => {
    const id = await createOauth();
    await expiring(id);
    host.grant = () => ({ status: 400, json: { error: 'invalid_grant' } });
    // Still valid for a minute: this use goes, the next one finds it refused.
    await withCredential(db as never, useOf(id, 2), async (opened) => opened.secret);
    expect((await listUserTokens(db as never, id))[0]!.state).toBe('invalid');
    const error = await withCredential(db as never, useOf(id, 2), async () => 'sent').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialRefusedError);
    expect((error as InstanceType<typeof CredentialRefusedError>).code).toBe('user-token-required');
  });

  test('is revoked at GitLab when it is removed, and only removed on Bitbucket, which offers no revocation', async () => {
    const gitlab = await createOauth();
    await authorize(gitlab);
    host.calls.length = 0;
    expect(await revokeUserTokens(db as never, (await loadCredentialRecord(db as never, gitlab))!, 2)).toBe(1);
    expect(host.calls.map((c) => c.url)).toEqual(['https://gitlab.com/oauth/revoke']);
    expect(host.calls[0]!.body?.get('token')).toMatch(/^refresh-/);

    const bitbucket = await createOauth(BITBUCKET);
    host.user = { status: 200, json: { nickname: 'alice-bb' } };
    await authorize(bitbucket);
    host.calls.length = 0;
    expect(await revokeUserTokens(db as never, (await loadCredentialRecord(db as never, bitbucket))!, 2)).toBe(1);
    expect(host.calls).toEqual([]);
  });

  test('never serves as a project’s source control: only a CI action runs in a person’s name', async () => {
    const id = await createOauth();
    expect(await projectScmCredentialProblem(db as never, 1, id, null)).toMatch(/name it in a CI action/);
  });
});
