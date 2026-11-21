import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * Client ID metadata documents: an MCP client whose `client_id` is an HTTPS
 * URL is described by the document there, fetched through the SSRF guard with
 * no redirect, a size cap and a timeout, kept as long as its `Cache-Control`
 * allows within bounds, and checked before the client signs in. The switch
 * turns it off, and dynamic registration stays.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const oauth = await import('../../server/utils/mcp-oauth');
const helpers = await import('../../server/utils/mcp-oauth-helpers');
const metadata = await import('../../server/utils/mcp-oauth-client-metadata');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let userId: number;

const BASE = 'https://piwi.example.com';
const T0 = new Date('2026-09-01T10:00:00Z');
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const CLIENT_ID = 'https://client.example.com/oauth/client.json';
const DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: 'Example Agent',
  client_uri: 'https://client.example.com',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

beforeEach(async () => {
  metadata.clearClientMetadataCache();
  delete process.env.PIWI_MCP_CLIENT_METADATA_DOCUMENTS;
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys=ON');
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'tester', password: 'x', role: 'member', name: 'Test User' })
    .returning();
  userId = user!.id;
});

afterEach(() => {
  delete process.env.PIWI_MCP_CLIENT_METADATA_DOCUMENTS;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = () => db as any;

/** A fetcher that answers each URL with `respond`, and records what it was asked. */
function fetcher(respond: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; maxRedirects: number; timeoutMs: number }> = [];
  const fetch: import('../../server/utils/mcp-oauth-client-metadata').MetadataFetch = async (
    url,
    _init,
    maxRedirects,
    timeoutMs,
  ) => {
    calls.push({ url, maxRedirects, timeoutMs });
    return respond(url);
  };
  return { fetch, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

function start(
  query: Record<string, unknown>,
  fetch?: import('../../server/utils/mcp-oauth-client-metadata').MetadataFetch,
) {
  return oauth.startAuthorization(
    anyDb(),
    {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${BASE}/mcp`,
      ...query,
    },
    BASE,
    T0,
    fetch,
  );
}

describe('the client_id that names a document', () => {
  test('is an https URL with a path, no credentials and no fragment, written as a URL parser writes it', () => {
    expect(metadata.isClientMetadataUrl(CLIENT_ID)).toBe(true);
    expect(metadata.isClientMetadataUrl('https://client.example.com:8443/c?v=1')).toBe(true);
    for (const value of [
      'http://client.example.com/client.json',
      'https://client.example.com',
      'https://client.example.com/',
      'https://user:pass@client.example.com/client.json',
      'https://client.example.com/client.json#x',
      'https://client.example.com/a/../client.json',
      'https://CLIENT.example.com/client.json',
      'mcpc_0123456789abcdef',
      `https://client.example.com/${'x'.repeat(2000)}`,
      42,
    ]) {
      expect(metadata.isClientMetadataUrl(value), String(value)).toBe(false);
    }
  });
});

describe('the document', () => {
  test('describes a public client whose client_id is the URL it came from', () => {
    expect(metadata.parseClientMetadata(CLIENT_ID, DOCUMENT)).toEqual({
      clientName: 'Example Agent',
      clientUri: 'https://client.example.com',
      redirectUris: [REDIRECT],
    });
    expect(
      metadata.parseClientMetadata(CLIENT_ID, { client_id: CLIENT_ID, client_name: 'A', redirect_uris: [REDIRECT] }),
    ).toMatchObject({ clientName: 'A', clientUri: null });
  });

  test('is refused when it does not check out', () => {
    for (const [document, why] of [
      [[], 'not an object'],
      [{ ...DOCUMENT, client_id: 'https://other.example.com/client.json' }, 'another client_id'],
      [{ ...DOCUMENT, client_name: '' }, 'no name'],
      [{ ...DOCUMENT, redirect_uris: ['javascript:alert(1)'] }, 'a redirect URI that cannot receive a code'],
      [{ ...DOCUMENT, redirect_uris: [] }, 'no redirect URI'],
      [{ ...DOCUMENT, grant_types: ['client_credentials'] }, 'another grant'],
      [{ ...DOCUMENT, response_types: ['token'] }, 'another response type'],
      [{ ...DOCUMENT, token_endpoint_auth_method: 'private_key_jwt' }, 'another authentication'],
      [{ ...DOCUMENT, client_secret: 'shh' }, 'a secret'],
    ] as const) {
      expect(metadata.parseClientMetadata(CLIENT_ID, document), why).toHaveProperty('problem');
    }
  });

  test('is kept as long as its Cache-Control allows, within bounds', () => {
    const { default: standard, min, max } = metadata.CLIENT_METADATA_CACHE_MS;
    expect(metadata.cacheLifetimeMs(null)).toBe(standard);
    expect(metadata.cacheLifetimeMs('public, max-age=600')).toBe(600_000);
    expect(metadata.cacheLifetimeMs('max-age=1')).toBe(min);
    expect(metadata.cacheLifetimeMs('max-age=99999999')).toBe(max);
    expect(metadata.cacheLifetimeMs('no-store')).toBe(0);
    expect(metadata.cacheLifetimeMs('private, no-cache')).toBe(0);
  });
});

describe('fetching the document', () => {
  test('follows no redirect, waits a bounded time, and keeps a document while it is fresh', async () => {
    const { fetch, calls } = fetcher(() => json(DOCUMENT, { 'cache-control': 'max-age=120' }));
    const now = T0.getTime();
    expect(await metadata.resolveClientMetadata(CLIENT_ID, now, fetch)).toMatchObject({ clientName: 'Example Agent' });
    expect(await metadata.resolveClientMetadata(CLIENT_ID, now + 119_000, fetch)).toMatchObject({
      clientName: 'Example Agent',
    });
    expect(calls).toEqual([{ url: CLIENT_ID, maxRedirects: 0, timeoutMs: metadata.CLIENT_METADATA_TIMEOUT_MS }]);
    await metadata.resolveClientMetadata(CLIENT_ID, now + 121_000, fetch);
    expect(calls).toHaveLength(2);
  });

  test('keeps nothing the server says not to', async () => {
    const { fetch, calls } = fetcher(() => json(DOCUMENT, { 'cache-control': 'no-store' }));
    await metadata.resolveClientMetadata(CLIENT_ID, T0.getTime(), fetch);
    await metadata.resolveClientMetadata(CLIENT_ID, T0.getTime(), fetch);
    expect(calls).toHaveLength(2);
  });

  test('refuses an address that does not answer 200, a long body, a body that is not JSON, and a failed fetch', async () => {
    const big = 'x'.repeat(metadata.CLIENT_METADATA_MAX_BYTES + 1);
    for (const [respond, why] of [
      [
        () => new Response('moved', { status: 302, headers: { location: 'https://elsewhere.example.com/' } }),
        'redirect',
      ],
      [() => new Response('nope', { status: 404 }), '404'],
      [() => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } }), 'declared long'],
      [() => new Response(new Blob([big]).stream(), { status: 200 }), 'streamed long'],
      [() => new Response('<html>', { status: 200 }), 'not JSON'],
      [
        () => {
          throw new Error('URL host is not allowed');
        },
        'refused address',
      ],
    ] as const) {
      metadata.clearClientMetadataCache();
      const result = await metadata.resolveClientMetadata(CLIENT_ID, T0.getTime(), fetcher(respond).fetch);
      expect(result, why).toHaveProperty('problem');
    }
  });

  test('goes through the SSRF guard: no loopback, private or local address is fetched', async () => {
    for (const url of [
      'https://127.0.0.1/client.json',
      'https://localhost/client.json',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.8/client.json',
      'https://[::1]/client.json',
      'https://printer.local/client.json',
    ]) {
      const result = await metadata.resolveClientMetadata(url, T0.getTime());
      expect(result, url).toMatchObject({ problem: expect.stringContaining('not allowed') });
    }
  });
});

describe('signing in with a metadata document', () => {
  test('is advertised in the server metadata only when on', () => {
    expect(helpers.authorizationServerMetadata(BASE, { clientMetadataDocuments: true })).toMatchObject({
      client_id_metadata_document_supported: true,
      registration_endpoint: `${BASE}/oauth/register`,
    });
    expect(helpers.authorizationServerMetadata(BASE)).not.toHaveProperty('client_id_metadata_document_supported');
    expect(metadata.clientMetadataDocumentsEnabled({})).toBe(true);
    expect(metadata.clientMetadataDocumentsEnabled({ PIWI_MCP_CLIENT_METADATA_DOCUMENTS: 'false' })).toBe(false);
  });

  test('creates the client from its document, shows its host on the consent page, and redeems the code as a public client', async () => {
    const { fetch } = fetcher(() => json(DOCUMENT));
    const started = await start({}, fetch);
    if (started.kind !== 'consent') throw new Error(JSON.stringify(started));
    expect(await oauth.describeAuthorization(anyDb(), started.requestId, T0)).toMatchObject({
      clientName: 'Example Agent',
      clientUri: 'https://client.example.com',
      clientIdHost: 'client.example.com',
      redirect: { kind: 'loopback' },
    });
    const decision = await oauth.decideAuthorization(
      anyDb(),
      { requestId: started.requestId, userId, allow: true },
      BASE,
      T0,
    );
    if (decision.status !== 'approved') throw new Error(decision.status);
    const code = new URL(decision.redirectTo).searchParams.get('code')!;
    const issued = await oauth.exchangeToken(
      anyDb(),
      { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER },
      { clientId: CLIENT_ID, clientSecret: null, basic: false },
      BASE,
      T0,
    );
    expect(issued).toMatchObject({ token_type: 'Bearer', scope: 'mcp' });
    const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, userId));
    expect(key?.name).toBe('Example Agent');
  });

  test('follows the document on the next authorization, in one client row', async () => {
    await start({}, fetcher(() => json(DOCUMENT)).fetch);
    metadata.clearClientMetadataCache();
    const renamed = { ...DOCUMENT, client_name: 'Example Agent 2', redirect_uris: ['https://client.example.com/cb'] };
    expect(
      await start({ redirect_uri: 'https://client.example.com/cb' }, fetcher(() => json(renamed)).fetch),
    ).toMatchObject({
      kind: 'consent',
    });
    const rows = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, CLIENT_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientName: 'Example Agent 2', redirectUris: ['https://client.example.com/cb'] });
    // The redirect URI the document no longer lists is refused.
    expect(await start({}, fetcher(() => json(renamed)).fetch)).toEqual({
      kind: 'refused',
      error: 'invalid_redirect_uri',
    });
  });

  test('a document that cannot be used is shown on the consent page, and no client is kept', async () => {
    const { fetch } = fetcher(() => json({ ...DOCUMENT, client_id: 'https://other.example.com/client.json' }));
    expect(await start({}, fetch)).toEqual({ kind: 'refused', error: 'invalid_client_metadata' });
    expect(await db.select().from(schema.oauthClients)).toEqual([]);
  });

  test('turned off, a URL client_id is an unknown client, before and after it signed in', async () => {
    await start({}, fetcher(() => json(DOCUMENT)).fetch);
    process.env.PIWI_MCP_CLIENT_METADATA_DOCUMENTS = 'false';
    const { fetch, calls } = fetcher(() => json(DOCUMENT));
    expect(await start({}, fetch)).toEqual({ kind: 'refused', error: 'invalid_client' });
    expect(calls).toEqual([]);
    expect(
      await oauth.exchangeToken(
        anyDb(),
        { grant_type: 'refresh_token', refresh_token: 'pdr_x' },
        { clientId: CLIENT_ID, clientSecret: null, basic: false },
        BASE,
        T0,
      ),
    ).toMatchObject({ error: 'invalid_client' });
  });
});
