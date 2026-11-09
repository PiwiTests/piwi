import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * What a cluster's Activity says about Piwi's writes to its tracker issue: the
 * issue filed by a person or by a rule, a filing a rule left to a person, the
 * comments and moves with their reason, and the description updates, sent or
 * left alone, against an in-memory SQLite database.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getClusterActivity } = await import('#shared/handlers/cluster-activity');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let at = Date.parse('2026-10-01T10:00:00Z');

/** One of Piwi's writes on cluster 1, a minute after the previous one. */
function write(row: {
  kind: string;
  dedupeKey: string;
  status: string;
  payload?: unknown;
  result?: unknown;
  error?: string | null;
}) {
  at += 60_000;
  return {
    connectionId: 1,
    projectId: 1,
    entityType: 'failure_cluster',
    entityId: 1,
    attempts: 1,
    payload: (row.payload ?? {}) as never,
    result: (row.result ?? null) as never,
    error: row.error ?? null,
    kind: row.kind,
    dedupeKey: row.dedupeKey,
    status: row.status,
    createdAt: new Date(at),
    finishedAt: new Date(at),
  };
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date(at) });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'Error: broken',
    errorType: 'unknown',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db
    .insert(schema.integrationConnections)
    .values({ id: 1, provider: 'jira', name: 'Jira', baseUrl: 'https://acme.atlassian.net' });
  await db.insert(schema.integrationActions).values([
    write({
      kind: 'create-issue',
      dedupeKey: 'create-issue:failure_cluster:1:conn1:retired:1',
      status: 'done',
      result: { key: 'PROJ-1' },
    }),
    write({
      kind: 'create-issue',
      dedupeKey: 'create-issue:failure_cluster:1:conn1:retired:2',
      status: 'skipped',
      payload: { automatic: null, existingKey: 'PROJ-900' },
      error: "PROJ-900 already carries this failure's labels: link it from the cluster page",
    }),
    write({
      kind: 'create-issue',
      dedupeKey: 'create-issue:failure_cluster:1:conn1',
      status: 'done',
      payload: { automatic: { occurrences: 2, runs: 2 } },
      result: { key: 'PROJ-2' },
    }),
    write({
      kind: 'comment',
      dedupeKey: 'comment:failure_cluster:1:diagnosis:1780000000000',
      status: 'done',
      payload: { issueKey: 'PROJ-2' },
    }),
    write({
      kind: 'update-issue',
      dedupeKey: 'update-issue:failure_cluster:1:diagnosis:1780000000000',
      status: 'done',
      payload: { issueKey: 'PROJ-2' },
      result: { updated: true },
    }),
    write({
      kind: 'update-issue',
      dedupeKey: 'update-issue:failure_cluster:1:day:2026-10-02',
      status: 'done',
      payload: { issueKey: 'PROJ-2' },
      result: { updated: false },
    }),
    write({
      kind: 'update-issue',
      dedupeKey: 'update-issue:failure_cluster:1:day:2026-10-03',
      status: 'skipped',
      payload: { issueKey: 'PROJ-2' },
      error: 'the description was edited in the tracker',
    }),
    write({
      kind: 'transition',
      dedupeKey: 'transition:failure_cluster:1:reopen:r1',
      status: 'done',
      payload: { issueKey: 'PROJ-2' },
    }),
  ]);
});

describe("a cluster's Activity of the writes to its issue", () => {
  test('names each write, newest first, and leaves out an update that changed nothing', async () => {
    const activity = await getClusterActivity(db as never, 1);
    expect(activity.map((a) => [a.text, a.status])).toEqual([
      ['Piwi moved PROJ-2 (the failure came back)', 'ok'],
      ['Left the description of PROJ-2: edited in the tracker', 'skipped'],
      ['Piwi updated the description of PROJ-2 (the failure was diagnosed)', 'ok'],
      ['Piwi commented on PROJ-2 (the failure was diagnosed)', 'ok'],
      ['Piwi filed PROJ-2 (by a rule)', 'ok'],
      ["A rule left the filing to a person: PROJ-900 is already open with this failure's labels", 'skipped'],
      ['Piwi filed PROJ-1', 'ok'],
    ]);
    expect(activity[0]!.runId).toBe(1);
  });

  test('a daily description update says the failure failed again', async () => {
    await db.insert(schema.integrationActions).values(
      write({
        kind: 'update-issue',
        dedupeKey: 'update-issue:failure_cluster:1:day:2026-10-04',
        status: 'done',
        payload: { issueKey: 'PROJ-2' },
        result: { updated: true },
      }),
    );
    const [newest] = await getClusterActivity(db as never, 1);
    expect(newest).toMatchObject({
      text: 'Piwi updated the description of PROJ-2 (the failure failed again)',
      status: 'ok',
    });
  });

  test('a filing refused for good is an error', async () => {
    await db.insert(schema.integrationActions).values(
      write({
        kind: 'create-issue',
        dedupeKey: 'create-issue:failure_cluster:1:conn1:retired:9',
        status: 'failed',
        error: 'Severity is required',
      }),
    );
    const [newest] = await getClusterActivity(db as never, 1);
    expect(newest).toMatchObject({ text: 'Filing an issue failed: Severity is required', status: 'error' });
  });
});
