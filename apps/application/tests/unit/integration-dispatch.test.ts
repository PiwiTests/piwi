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
import { connectionBaseUrl } from '../../shared/integrations/registry';
import { IntegrationHttpError, parseRetryAfter, RETRY_AFTER_CAP_MS } from '../../server/utils/integrations/http-error';

/**
 * The outbox runs each action through the binding and the client of its integration kind; a provider's
 * `Retry-After` sets the next attempt, and a 429 holds the connection's other pending actions as long.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { boundConnectionId } = await import('../../server/utils/integrations/bound-connection');
const { enqueueAction, isFinalRefusal, runActionNow } = await import('../../server/utils/integrations/actions');
const { JiraError } = await import('../../server/utils/integrations/jira/client');
const { CONNECTION_CHECKS } = await import('../../server/utils/integrations/connection-check');
const { buildFixComment } = await import('../../shared/integrations/policy-comments');

const SITE = 'https://dispatch.atlassian.net';
const OTHER_SITE = 'https://elsewhere.atlassian.net';

/** What the stub Jira answers a comment with: 201, or a 429 with this `Retry-After`. */
let commentAnswer: { status: 201 } | { status: 429; retryAfter: string } = { status: 201 };

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (/\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(url.pathname) && init?.method === 'POST') {
    if (commentAnswer.status === 429) {
      return new Response('{}', { status: 429, headers: { 'retry-after': commentAnswer.retryAfter } });
    }
    return new Response(JSON.stringify({ id: '1' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ errorMessages: ['Not found'] }), { status: 404 });
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;
let otherConnectionId = 0;
let seq = 0;

function commentInput(overrides: { connectionId?: number; projectId?: number; kind?: string } = {}) {
  seq++;
  return {
    connectionId,
    projectId: 1,
    kind: 'comment',
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
    ...overrides,
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
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', label: 'Shop' },
    { id: 2, name: 'admin', label: 'Admin' },
  ]);
  vi.stubGlobal('fetch', vi.fn(jira));
  const credentials = { email: 'ci@example.com', apiToken: 'token' };
  connectionId = (await createConnection(dbc, { provider: 'jira', name: 'Shop Jira', baseUrl: SITE, credentials })).id;
  otherConnectionId = (
    await createConnection(dbc, { provider: 'jira', name: 'Admin Jira', baseUrl: OTHER_SITE, credentials })
  ).id;
  await writeProjectIntegration(dbc, 1, { connectionId, projectKey: 'PROJ', issueType: 'Bug' });
  await writeProjectIntegration(dbc, 2, { connectionId: otherConnectionId, projectKey: 'ADM', issueType: 'Bug' });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  commentAnswer = { status: 201 };
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

  test('ignores a missing or unreadable header', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
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
    expect(await boundConnectionId(dbc, 1, 'tracker')).toBe(connectionId);
    expect(await boundConnectionId(dbc, 1, 'test-management')).toBeNull();
    expect(await boundConnectionId(dbc, 1, 'wiki')).toBeNull();
    expect(await boundConnectionId(dbc, null, 'tracker')).toBeNull();
  });

  test('an action of a kind the outbox does not run is skipped without a call', async () => {
    const fetchMock = vi.mocked(fetch);
    const calls = fetchMock.mock.calls.length;
    const action = await enqueueAction(dbc, commentInput({ kind: 'sync-status' }));
    expect(await runActionNow(dbc, action.id)).toEqual({
      status: 'skipped',
      reason: "unsupported action kind 'sync-status'",
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});

describe('a rate-limited connection', () => {
  test("waits as long as the provider asks, and holds the connection's other actions as long", async () => {
    commentAnswer = { status: 429, retryAfter: '600' };
    const limited = await enqueueAction(dbc, commentInput());
    const waiting = await enqueueAction(dbc, commentInput());
    const later = await enqueueAction(dbc, commentInput());
    const farLater = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await db
      .update(schema.integrationActions)
      .set({ scheduledFor: farLater })
      .where(eq(schema.integrationActions.id, later.id));
    const elsewhere = await enqueueAction(dbc, commentInput({ connectionId: otherConnectionId, projectId: 2 }));

    const before = Date.now();
    expect(await runActionNow(dbc, limited.id)).toMatchObject({ status: 'failed', retrying: true });

    const retryAt = (await actionRow(limited.id)).scheduledFor!.getTime();
    expect(retryAt - before).toBeGreaterThanOrEqual(600_000);
    expect(retryAt - before).toBeLessThan(610_000);
    // The connection's other pending action waits until the same moment; one due later keeps its time.
    expect((await actionRow(waiting.id)).scheduledFor!.getTime()).toBe(retryAt);
    expect((await actionRow(later.id)).scheduledFor!.getTime()).toBe(farLater.getTime());
    // Another connection is not held.
    expect((await actionRow(elsewhere.id)).scheduledFor!.getTime()).toBeLessThan(retryAt);
  });

  test('a failure that is not a 429 holds nothing else', async () => {
    const failing = await enqueueAction(dbc, { ...commentInput(), payload: { issueKey: 'PROJ-X', document: null } });
    const other = await enqueueAction(dbc, commentInput());
    const scheduled = (await actionRow(other.id)).scheduledFor!.getTime();
    expect(await runActionNow(dbc, failing.id)).toMatchObject({ status: 'failed' });
    expect((await actionRow(other.id)).scheduledFor!.getTime()).toBe(scheduled);
  });
});

describe('connection endpoints', () => {
  test('a provider reached at a typed address needs a valid URL', () => {
    expect(connectionBaseUrl('jira', { baseUrl: SITE })).toEqual({ baseUrl: SITE });
    expect(connectionBaseUrl('jira', { baseUrl: 'not a url' })).toEqual({ error: 'Must be a valid URL' });
    expect(connectionBaseUrl('jira', {})).toEqual({ error: 'Enter the address of the site' });
    expect(connectionBaseUrl('linear', { baseUrl: SITE })).toEqual({ error: 'Unknown provider' });
  });

  test('every provider has a pre-save check', () => {
    expect(Object.keys(CONNECTION_CHECKS)).toEqual(['jira']);
  });
});
