import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getFailureCluster } = await import('../../shared/handlers/failure-clusters');
const { getTestRunCase } = await import('../../shared/handlers/test-cases');
const { collectClusterBundle, collectExecutionBundle } = await import('../../shared/export/collect');

const FILER = 'Robin Shaw';

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.users).values({ id: 7, username: 'robin', password: '', role: 'member', name: FILER });
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date(1_000) });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'pays' });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'Error: broken',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    occurrences: 1,
  });
  await db.insert(schema.testRunsCases).values({
    id: 10,
    testRunId: 1,
    testCaseId: 1,
    status: 'failed',
    error: 'Error: broken',
    failureClusterId: 1,
  });
  await db.insert(schema.entityLinks).values({
    failureClusterId: 1,
    url: 'https://example.atlassian.net/browse/PROJ-1',
    provider: 'jira',
    key: 'PROJ-1',
    origin: 'created',
    createdBy: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe('the files and share links an export is served as', () => {
  test('the dashboard names who filed the issue, the exports do not', async () => {
    const cluster = (await getFailureCluster(db as never, 1)) as Record<string, any>;
    expect(cluster.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: FILER });
    const execution = (await getTestRunCase(db as never, 10)) as Record<string, any>;
    expect(execution.failureCluster?.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: FILER });

    const clusterBundle = (await collectClusterBundle(db as never, 1, { maxCases: 5 }))!;
    expect(clusterBundle.cluster?.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: null });
    expect(JSON.stringify(clusterBundle)).not.toContain(FILER);

    const executionBundle = (await collectExecutionBundle(db as never, 10, { maxCases: 5 }))!;
    expect(executionBundle.cases[0]?.detail.failureCluster?.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: null });
    expect(JSON.stringify(executionBundle)).not.toContain(FILER);
  });
});
