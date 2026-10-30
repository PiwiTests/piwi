import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * Whether automatic creation reads a cluster as tracked: the rule a new filing
 * follows (an issue that is not Done, or a Done one a reopen transition is
 * moving out of Done) plus a filing the tracker has not answered yet, against an
 * in-memory SQLite database.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { gatherAutoCreateFacts } = await import('#shared/handlers/tracker-automation');
const { knownIssueTracks } = await import('#shared/handlers/known-issues');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const CLUSTERS = {
  inProgress: 1,
  done: 2,
  doneRegressed: 3,
  queued: 4,
  queuedFromExecution: 5,
  untracked: 6,
  reopenQueued: 7,
  reopenedSinceRead: 8,
  reopenReadBack: 9,
  reopenOtherIssue: 10,
};
/** When the Done links were last read back from the tracker. */
const READ_BACK = new Date('2026-09-02T10:00:00Z');
const REGRESSED = new Set([
  CLUSTERS.doneRegressed,
  CLUSTERS.reopenQueued,
  CLUSTERS.reopenedSinceRead,
  CLUSTERS.reopenReadBack,
  CLUSTERS.reopenOtherIssue,
]);

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, title: 'pays', filePath: 'tests/pay.spec.ts' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    startTime: new Date('2026-09-01T10:00:00Z'),
  });
  await db.insert(schema.failureClusters).values(
    Object.values(CLUSTERS).map((id) => ({
      id,
      projectId: 1,
      fingerprint: `fp-${id}`,
      signature: `Error: ${id}`,
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      fixVerification: REGRESSED.has(id) ? 'regressed' : null,
    })),
  );
  await db.insert(schema.testRunsCases).values(
    Object.values(CLUSTERS).map((id) => ({
      id: 100 + id,
      testRunId: 1,
      testCaseId: 1,
      status: 'failed',
      error: `Error: ${id}`,
      failureClusterId: id,
    })),
  );
  const jiraLink = (clusterId: number, key: string, statusCategory: string) => ({
    failureClusterId: clusterId,
    url: `https://acme.atlassian.net/browse/${key}`,
    provider: 'jira',
    key,
    origin: 'created',
    metadata: { statusCategory } as never,
    unfurledAt: READ_BACK,
  });
  await db
    .insert(schema.entityLinks)
    .values([
      jiraLink(CLUSTERS.inProgress, 'PIWI-1', 'indeterminate'),
      jiraLink(CLUSTERS.done, 'PIWI-2', 'done'),
      jiraLink(CLUSTERS.doneRegressed, 'PIWI-3', 'done'),
      jiraLink(CLUSTERS.reopenQueued, 'PIWI-7', 'done'),
      jiraLink(CLUSTERS.reopenedSinceRead, 'PIWI-8', 'done'),
      jiraLink(CLUSTERS.reopenReadBack, 'PIWI-9', 'done'),
      jiraLink(CLUSTERS.reopenOtherIssue, 'PIWI-10', 'done'),
    ]);
  await db
    .insert(schema.integrationConnections)
    .values({ id: 1, provider: 'jira', name: 'Jira', baseUrl: 'https://acme.atlassian.net' });
  await db.insert(schema.integrationActions).values([
    {
      connectionId: 1,
      projectId: 1,
      kind: 'create-issue',
      entityType: 'failure_cluster',
      entityId: CLUSTERS.queued,
      dedupeKey: `create-issue:failure_cluster:${CLUSTERS.queued}:conn1`,
      status: 'pending',
      attempts: 1,
      payload: {} as never,
    },
    {
      connectionId: 1,
      projectId: 1,
      kind: 'create-issue',
      entityType: 'test_runs_case',
      entityId: 100 + CLUSTERS.queuedFromExecution,
      dedupeKey: `create-issue:test_runs_case:${100 + CLUSTERS.queuedFromExecution}:conn1`,
      status: 'pending',
      attempts: 1,
      payload: {} as never,
    },
  ]);
  // The regression policy's reopen transitions, on the cluster's issue unless said otherwise.
  const reopen = (clusterId: number, status: string, finishedAt: Date | null, issueKey = `PIWI-${clusterId}`) => ({
    connectionId: 1,
    projectId: 1,
    kind: 'transition',
    entityType: 'failure_cluster',
    entityId: clusterId,
    dedupeKey: `transition:failure_cluster:${clusterId}:reopen:r1`,
    status,
    attempts: status === 'pending' ? 0 : 1,
    payload: { issueKey, transitionId: '31' } as never,
    finishedAt,
  });
  await db
    .insert(schema.integrationActions)
    .values([
      reopen(CLUSTERS.reopenQueued, 'pending', null),
      reopen(CLUSTERS.reopenedSinceRead, 'done', new Date(READ_BACK.getTime() + 60_000)),
      reopen(CLUSTERS.reopenReadBack, 'done', new Date(READ_BACK.getTime() - 60_000)),
      reopen(CLUSTERS.reopenOtherIssue, 'pending', null, 'PIWI-99'),
    ]);
});

async function trackedClusters(): Promise<number[]> {
  const facts = await gatherAutoCreateFacts(db as never, Object.values(CLUSTERS), { defaultBranch: 'main' });
  return [...facts.values()].filter((f) => f.tracked).map((f) => f.clusterId);
}

describe('the tracked fact automatic creation reads', () => {
  test('an issue that is not Done tracks the cluster; a Done one no longer does', async () => {
    const tracked = await trackedClusters();
    expect(tracked).toContain(CLUSTERS.inProgress);
    expect(tracked).not.toContain(CLUSTERS.done);
    expect(tracked).not.toContain(CLUSTERS.untracked);
  });

  test('a Done issue under a regressed cluster no longer tracks it once no reopen is under way', async () => {
    // Regressed with no reopen transition, or one the sync has read back since: the issue stays Done.
    const tracked = await trackedClusters();
    expect(tracked).not.toContain(CLUSTERS.doneRegressed);
    expect(tracked).not.toContain(CLUSTERS.reopenReadBack);
  });

  test('a Done issue tracks the cluster while a reopen transition moves it out of Done', async () => {
    const tracked = await trackedClusters();
    // Queued on the tracker, or done after the link was last read back.
    expect(tracked).toContain(CLUSTERS.reopenQueued);
    expect(tracked).toContain(CLUSTERS.reopenedSinceRead);
    // A reopen of another issue says nothing about this one.
    expect(tracked).not.toContain(CLUSTERS.reopenOtherIssue);
  });

  test('a filing waiting on the tracker counts, asked from the cluster or from one of its executions', async () => {
    const tracked = await trackedClusters();
    expect(tracked).toContain(CLUSTERS.queued);
    expect(tracked).toContain(CLUSTERS.queuedFromExecution);
  });
});

describe('knownIssueTracks', () => {
  test('no issue tracks nothing; an issue not Done tracks, whatever its category', () => {
    expect(knownIssueTracks(null, { reopening: true })).toBe(false);
    expect(knownIssueTracks({ statusCategory: 'new' }, { reopening: false })).toBe(true);
    expect(knownIssueTracks({ statusCategory: null }, { reopening: false })).toBe(true);
  });

  test('a Done issue tracks only while a reopen moves it out of Done', () => {
    expect(knownIssueTracks({ statusCategory: 'done' }, { reopening: false })).toBe(false);
    expect(knownIssueTracks({ statusCategory: 'done' }, { reopening: true })).toBe(true);
  });
});
