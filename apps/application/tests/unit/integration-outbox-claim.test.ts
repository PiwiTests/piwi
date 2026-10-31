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

/**
 * The integration outbox writes to Jira once per action: two enqueues of one
 * key share a row, a click and a sweep (or two clicks) racing on a new action
 * make one call, an action another attempt holds is left alone, and a claim
 * whose lease ran out is retried.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { enqueueAction, enqueueOrReplaceAction, runActionNow, sweepIntegrationActions } =
  await import('../../server/utils/integrations/actions');
const { buildFixComment } = await import('../../shared/integrations/policy-comments');
const { OUTBOX_LEASE_MS } = await import('../../server/utils/outbox');

const SITE = 'https://claims.atlassian.net';

/** Issue keys Jira received a comment for, in order. */
let commented: string[] = [];

/** A stub Jira that answers a comment after a moment, so a racing attempt arrives while it is in flight. */
async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const comment = /\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(url.pathname);
  if (comment && init?.method === 'POST') {
    await new Promise((resolve) => setTimeout(resolve, 5));
    commented.push(comment[1]!);
    return new Response(JSON.stringify({ id: '1' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ errorMessages: ['Not found'] }), { status: 404 });
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;
let seq = 0;

function commentInput(issueKey: string) {
  seq++;
  return {
    connectionId,
    projectId: 1,
    kind: 'comment',
    entityType: 'failure_cluster',
    entityId: 1,
    dedupeKey: `comment:failure_cluster:1:claims:${seq}`,
    payload: {
      issueKey,
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
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-integration-claims-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  vi.stubGlobal('fetch', vi.fn(jira));
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: 'Claims Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  connectionId = connection.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  commented = [];
  await db.delete(schema.integrationActions);
});

describe('integration outbox claims', () => {
  test('two enqueues of one key racing return the same row', async () => {
    const input = commentInput('PROJ-1');
    const [a, b] = await Promise.all([enqueueAction(dbc, input), enqueueAction(dbc, input)]);

    expect(a.id).toBe(b.id);
    expect(await db.select().from(schema.integrationActions)).toHaveLength(1);
  });

  test('a click and a sweep racing on a new action comment once', async () => {
    const action = await enqueueAction(dbc, commentInput('PROJ-2'));
    const [clicked] = await Promise.all([runActionNow(dbc, action.id), sweepIntegrationActions(dbc)]);

    expect(commented).toEqual(['PROJ-2']);
    expect(clicked).toEqual({ status: 'done' });
    expect(await actionRow(action.id)).toMatchObject({ status: 'done', attempts: 1 });
  });

  test('two clicks racing comment once; the second finds the action in flight', async () => {
    const action = await enqueueAction(dbc, commentInput('PROJ-3'));
    const outcomes = await Promise.all([runActionNow(dbc, action.id), runActionNow(dbc, action.id)]);

    expect(commented).toEqual(['PROJ-3']);
    expect(outcomes).toContainEqual({ status: 'done' });
    expect(outcomes).toContain(null);
  });

  test('an action another attempt holds is left alone', async () => {
    const action = await enqueueAction(dbc, commentInput('PROJ-4'));
    await db
      .update(schema.integrationActions)
      .set({ status: 'processing', scheduledFor: new Date(Date.now() + OUTBOX_LEASE_MS) })
      .where(eq(schema.integrationActions.id, action.id));

    expect(await sweepIntegrationActions(dbc)).toEqual({ done: 0, failed: 0, skipped: 0 });
    expect(await runActionNow(dbc, action.id)).toBeNull();
    const replaced = await enqueueOrReplaceAction(dbc, { ...commentInput('PROJ-4'), dedupeKey: action.dedupeKey });
    expect(replaced).toMatchObject({ id: action.id, status: 'processing' });
    expect(commented).toEqual([]);
  });

  test('a claim whose lease ran out is retried by the sweep', async () => {
    const action = await enqueueAction(dbc, commentInput('PROJ-5'));
    await db
      .update(schema.integrationActions)
      .set({ status: 'processing', scheduledFor: new Date(Date.now() - 1000) })
      .where(eq(schema.integrationActions.id, action.id));

    expect(await sweepIntegrationActions(dbc)).toEqual({ done: 1, failed: 0, skipped: 0 });
    expect(commented).toEqual(['PROJ-5']);
    expect((await actionRow(action.id)).status).toBe('done');
  });
});
