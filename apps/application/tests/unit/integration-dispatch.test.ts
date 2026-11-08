import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';
import { integrationKindOf } from '../../shared/integrations/action-keys';
import {
  connectionBaseUrl,
  endpointBaseUrl,
  INTEGRATION_PROVIDERS,
  selectFieldError,
  type CredentialField,
  type ProviderEndpoint,
} from '../../shared/integrations/registry';
import { IntegrationHttpError, parseRetryAfter, RETRY_AFTER_CAP_MS } from '../../server/utils/integrations/http-error';

/**
 * The outbox runs each action through the binding and the client of its integration kind; a provider's
 * `Retry-After` sets the next attempt, and a 429 pauses the connection: no attempt calls it before the pause ends.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { boundConnectionId } = await import('../../server/utils/integrations/bound-connection');
const { enqueueAction, isFinalRefusal, runActionNow, sweepIntegrationActions } =
  await import('../../server/utils/integrations/actions');
const { JiraError } = await import('../../server/utils/integrations/jira/client');
const { CONNECTION_CHECKS } = await import('../../server/utils/integrations/connection-check');
const { buildFixComment } = await import('../../shared/integrations/policy-comments');

/** What the stub Jira answers a comment with: 201, a 429 (with this `Retry-After`, if any) or a 503. */
let commentAnswer: { status: 201 } | { status: 429; retryAfter?: string } | { status: 503 } = { status: 201 };
/** How many comments the stub Jira was asked to post. */
let commentCalls = 0;

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (/\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(url.pathname) && init?.method === 'POST') {
    commentCalls++;
    if (commentAnswer.status === 429) {
      const headers: Record<string, string> = commentAnswer.retryAfter
        ? { 'retry-after': commentAnswer.retryAfter }
        : {};
      return new Response('{}', { status: 429, headers });
    }
    if (commentAnswer.status === 503) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ id: '1' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ errorMessages: ['Not found'] }), { status: 404 });
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let seq = 0;

/** A new project bound to a new Jira connection, so a pause on one test's connection holds no other test's. */
async function boundProject(): Promise<{ projectId: number; connectionId: number }> {
  seq++;
  const [project] = await db
    .insert(schema.projects)
    .values({ name: `dispatch-${seq}`, label: `Dispatch ${seq}` })
    .returning();
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: `Jira ${seq}`,
    baseUrl: `https://dispatch-${seq}.atlassian.net`,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  await writeProjectIntegration(dbc, project!.id, {
    connectionId: connection.id,
    projectKey: 'PROJ',
    issueType: 'Bug',
  });
  return { projectId: project!.id, connectionId: connection.id };
}

function commentInput(on: { projectId: number; connectionId: number }, kind = 'comment') {
  seq++;
  return {
    ...on,
    kind,
    entityType: 'failure_cluster',
    entityId: 1,
    dedupeKey: `comment:failure_cluster:1:dispatch:${seq}`,
    payload: {
      issueKey: `PROJ-${seq}`,
      document: buildFixComment('en', {
        runNumber: seq,
        commit: null,
        verification: 'stopped-failing',
        clusterUrl: null,
      }),
    },
  };
}

async function actionRow(id: number) {
  const [row] = await db.select().from(schema.integrationActions).where(eq(schema.integrationActions.id, id));
  return row!;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-integration-dispatch-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  vi.stubGlobal('fetch', vi.fn(jira));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  commentAnswer = { status: 201 };
  commentCalls = 0;
  await db.delete(schema.integrationActions);
});

describe('Retry-After', () => {
  const now = Date.parse('2026-11-08T06:00:00Z');

  test('reads delay-seconds and an HTTP date, counted from now', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('Sun, 08 Nov 2026 06:00:30 GMT', now)).toBe(30_000);
  });

  test('caps the wait at one hour, and a date in the past waits nothing', () => {
    expect(parseRetryAfter('86400', now)).toBe(RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter('Mon, 09 Nov 2026 06:00:00 GMT', now)).toBe(RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter('Sat, 07 Nov 2026 06:00:00 GMT', now)).toBe(0);
  });

  test('ignores a missing header and one in neither form', () => {
    for (const header of [null, '', 'soon', '-5', '1.5', 'a 2027', 'Retry 3000', 'Sun, 08 Nov 2026 06:00:30']) {
      expect(parseRetryAfter(header, now)).toBeUndefined();
    }
  });

  test('a refusal from any provider is final or retried by its status alone', () => {
    expect(isFinalRefusal(new IntegrationHttpError(422, 'refused'))).toBe(true);
    expect(isFinalRefusal(new IntegrationHttpError(429, 'slow down', 1000))).toBe(false);
    expect(isFinalRefusal(new IntegrationHttpError(503, 'down'))).toBe(false);
    expect(new JiraError(429, 'slow down', 5000)).toMatchObject({ status: 429, retryAfterMs: 5000 });
  });
});

describe('integration kinds', () => {
  test('every tracker action belongs to the tracker kind; an unknown kind to none', () => {
    for (const kind of ['create-issue', 'comment', 'update-issue', 'attach', 'transition']) {
      expect(integrationKindOf(kind)).toBe('tracker');
    }
    expect(integrationKindOf('sync-status')).toBeNull();
    expect(integrationKindOf('toString')).toBeNull();
  });

  test("a project's binding is read per kind", async () => {
    const shop = await boundProject();
    expect(await boundConnectionId(dbc, shop.projectId, 'tracker')).toBe(shop.connectionId);
    expect(await boundConnectionId(dbc, shop.projectId, 'test-management')).toBeNull();
    expect(await boundConnectionId(dbc, shop.projectId, 'wiki')).toBeNull();
    expect(await boundConnectionId(dbc, null, 'tracker')).toBeNull();
  });

  test('an action of a kind the outbox does not run is skipped without a call', async () => {
    const action = await enqueueAction(dbc, commentInput(await boundProject(), 'sync-status'));
    expect(await runActionNow(dbc, action.id)).toEqual({
      status: 'skipped',
      reason: "unsupported action kind 'sync-status'",
    });
    expect(commentCalls).toBe(0);
  });
});

describe('a rate-limited connection', () => {
  test("pauses for as long as the provider asks, holding the connection's other actions", async () => {
    const shop = await boundProject();
    const elsewhere = await boundProject();
    commentAnswer = { status: 429, retryAfter: '600' };
    const limited = await enqueueAction(dbc, commentInput(shop));
    const waiting = await enqueueAction(dbc, commentInput(shop));
    const later = await enqueueAction(dbc, commentInput(shop));
    const farLater = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await db
      .update(schema.integrationActions)
      .set({ scheduledFor: farLater })
      .where(eq(schema.integrationActions.id, later.id));
    const other = await enqueueAction(dbc, commentInput(elsewhere));

    const before = Date.now();
    expect(await runActionNow(dbc, limited.id)).toMatchObject({ status: 'failed', retrying: true });

    const retryAt = (await actionRow(limited.id)).scheduledFor!.getTime();
    expect(retryAt - before).toBeGreaterThanOrEqual(600_000);
    expect(retryAt - before).toBeLessThan(610_000);
    // The connection's other pending action waits until the same moment; one due later keeps its time.
    expect((await actionRow(waiting.id)).scheduledFor!.getTime()).toBe(retryAt);
    expect((await actionRow(later.id)).scheduledFor!.getTime()).toBe(farLater.getTime());
    // Another connection is not held.
    expect((await actionRow(other.id)).scheduledFor!.getTime()).toBeLessThan(retryAt);
  });

  test('a write made during the pause waits without calling the provider or spending an attempt', async () => {
    const shop = await boundProject();
    commentAnswer = { status: 429, retryAfter: '600' };
    await runActionNow(dbc, (await enqueueAction(dbc, commentInput(shop))).id);
    expect(commentCalls).toBe(1);

    commentAnswer = { status: 201 };
    const fresh = await enqueueAction(dbc, commentInput(shop));
    const outcome = await runActionNow(dbc, fresh.id);
    expect(outcome).toMatchObject({ status: 'failed', final: false, retrying: true });
    expect(commentCalls).toBe(1);
    const row = await actionRow(fresh.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    expect(row.error).toMatch(/^Waiting until .*: the provider rate limited this connection$/);
    expect(row.scheduledFor!.getTime() - Date.now()).toBeGreaterThan(590_000);

    // The sweep finds nothing of the connection's due before then.
    await sweepIntegrationActions(dbc);
    expect(commentCalls).toBe(1);
  });

  test('without a wait of its own, the pause is one minute, whatever the backoff of the limited action', async () => {
    const shop = await boundProject();
    commentAnswer = { status: 429 };
    const limited = await enqueueAction(dbc, commentInput(shop));
    // On its fourth attempt, the limited action itself backs off an hour.
    await db.update(schema.integrationActions).set({ attempts: 3 }).where(eq(schema.integrationActions.id, limited.id));
    const waiting = await enqueueAction(dbc, commentInput(shop));
    const before = Date.now();
    await runActionNow(dbc, limited.id);

    expect((await actionRow(limited.id)).scheduledFor!.getTime() - before).toBeGreaterThanOrEqual(60 * 60_000);
    const held = (await actionRow(waiting.id)).scheduledFor!.getTime() - before;
    expect(held).toBeGreaterThanOrEqual(60_000);
    expect(held).toBeLessThan(70_000);
  });

  test('a refusal that is not a 429 pauses nothing', async () => {
    const shop = await boundProject();
    commentAnswer = { status: 503 };
    const failing = await enqueueAction(dbc, commentInput(shop));
    const other = await enqueueAction(dbc, commentInput(shop));
    const scheduled = (await actionRow(other.id)).scheduledFor!.getTime();
    expect(await runActionNow(dbc, failing.id)).toMatchObject({ status: 'failed', retrying: true });
    expect((await actionRow(other.id)).scheduledFor!.getTime()).toBe(scheduled);

    commentAnswer = { status: 201 };
    expect(await runActionNow(dbc, other.id)).toEqual({ status: 'done' });
  });
});

describe('connection endpoints', () => {
  test('a provider reached at a typed address needs a valid URL', () => {
    const site = 'https://acme.atlassian.net';
    expect(connectionBaseUrl('jira', { baseUrl: site })).toEqual({ baseUrl: site });
    expect(connectionBaseUrl('jira', { baseUrl: site, region: 'eu' })).toEqual({ baseUrl: site });
    expect(connectionBaseUrl('jira', { baseUrl: 'not a url' })).toEqual({ error: 'Must be a valid URL' });
    expect(connectionBaseUrl('jira', {})).toEqual({ error: 'Enter the address of the site' });
    expect(connectionBaseUrl('linear', { baseUrl: site })).toEqual({ error: 'Unknown provider' });
  });

  test("a regional provider is reached on its region's host, never on a typed one", () => {
    const regional: ProviderEndpoint = {
      kind: 'region',
      regions: [
        { id: 'us', label: 'United States', baseUrl: 'https://api.example.com/v2' },
        { id: 'eu', label: 'Europe', baseUrl: 'https://eu.api.example.com/v2' },
      ],
    };
    expect(endpointBaseUrl(regional, { region: 'eu', baseUrl: 'https://attacker.example' })).toEqual({
      baseUrl: 'https://eu.api.example.com/v2',
      region: 'eu',
    });
    expect(endpointBaseUrl(regional, { baseUrl: 'https://api.example.com/v2' })).toEqual({
      error: 'Choose one of the provider’s regions',
    });
    expect(endpointBaseUrl(regional, { region: 'mars' })).toHaveProperty('error');
  });

  test('a select credential field takes one of its options only', () => {
    const fields: CredentialField[] = [
      { key: 'flavor', label: 'Flavor', type: 'select', options: [{ value: 'cloud', label: 'Cloud' }] },
      { key: 'apiToken', label: 'API token', type: 'password', secret: true },
    ];
    expect(selectFieldError(fields, { flavor: 'cloud', apiToken: 'x' })).toBeNull();
    expect(selectFieldError(fields, { apiToken: 'x' })).toBeNull();
    expect(selectFieldError(fields, { flavor: 'server' })).toBe('Flavor: choose one of its options');
  });

  test('every provider has a pre-save check', () => {
    expect(Object.keys(CONNECTION_CHECKS).sort()).toEqual(Object.keys(INTEGRATION_PROVIDERS).sort());
  });
});
