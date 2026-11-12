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
const COMMENTER = 'Robin S.';
const NOTE = 'Seen on checkout only';

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
  const person = { origin: 'created', createdBy: 7, createdAt: new Date(), updatedAt: new Date() };
  await db.insert(schema.entityLinks).values([
    {
      ...person,
      failureClusterId: 1,
      url: 'https://example.atlassian.net/browse/PROJ-1',
      provider: 'jira',
      key: 'PROJ-1',
      metadata: { filedBy: FILER, written: true, comment: { text: NOTE, author: COMMENTER } },
    },
    { ...person, testRunsCaseId: 10, url: 'https://example.com/case', provider: 'link', metadata: { filedBy: FILER } },
    { ...person, testCaseId: 1, url: 'https://example.com/test', provider: 'link' },
    { ...person, testRunId: 1, url: 'https://example.com/run', provider: 'link' },
  ]);
});

describe('the files and share links an export is served as', () => {
  test('the dashboard names who filed the issue, the exports do not', async () => {
    const cluster = (await getFailureCluster(db as never, 1)) as Record<string, any>;
    expect(cluster.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: FILER });
    expect(cluster.links[0].metadata.filedBy).toBe(FILER);
    const execution = (await getTestRunCase(db as never, 10)) as Record<string, any>;
    expect(execution.failureCluster?.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: FILER });

    const clusterBundle = (await collectClusterBundle(db as never, 1, { maxCases: 5 }))!;
    expect(clusterBundle.cluster?.knownIssue).toMatchObject({ key: 'PROJ-1', filedBy: null });
    const executionBundle = (await collectExecutionBundle(db as never, 10, { maxCases: 5 }))!;
    expect(executionBundle.cases[0]?.detail.failureCluster?.knownIssue).toMatchObject({
      key: 'PROJ-1',
      filedBy: null,
    });

    // The JSON download and the ZIP's data.json are this bundle, serialized.
    for (const bundle of [clusterBundle, executionBundle]) {
      const file = JSON.stringify(bundle, null, 2);
      expect(file).not.toContain(FILER);
      expect(file).not.toContain(COMMENTER);
      expect(file).not.toContain('createdBy');
      expect(file).not.toContain('filedBy": "');
    }
  });

  test('a link keeps what the file needs of it', async () => {
    const clusterBundle = (await collectClusterBundle(db as never, 1, { maxCases: 5 }))!;
    const [link] = (clusterBundle.cluster as Record<string, any>).links;
    expect(link).toMatchObject({
      key: 'PROJ-1',
      url: 'https://example.atlassian.net/browse/PROJ-1',
      origin: 'created',
    });
    expect(link.metadata).toMatchObject({ written: true, comment: { text: NOTE, author: null } });
    expect(link).not.toHaveProperty('createdBy');

    const executionBundle = (await collectExecutionBundle(db as never, 10, { maxCases: 5 }))!;
    const detail = executionBundle.cases[0]!.detail;
    expect(detail.links.map((l: any) => l.url)).toEqual(['https://example.com/case']);
    expect(detail.stableLinks.map((l: any) => l.url)).toEqual(['https://example.com/test']);
    expect(detail.testRun.links.map((l: any) => l.url)).toEqual(['https://example.com/run']);
  });
});
