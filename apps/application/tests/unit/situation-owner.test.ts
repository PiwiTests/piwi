import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * The owner and the diagnosis an execution's detail reads, against an in-memory
 * SQLite database: a CODEOWNERS owner the caller resolves is named in the
 * situation sentence and the verdict alike, an annotation wins over it, and the
 * diagnosis is the cluster's own.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getTestRunCase } = await import('#shared/handlers/test-cases');

type Detail = {
  verdict: { owner: { name: string; source: string } | null } | null;
  situation: { text: string } | null;
  failureCluster: { diagnosis: { summary: string | null } | null } | null;
};

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, title: 'pays by card', filePath: 'tests/checkout.spec.ts' },
    { id: 2, projectId: 1, title: 'pays by transfer', filePath: 'tests/transfer.spec.ts', owner: '@checkout-team' },
  ]);
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    startTime: new Date('2026-09-01T10:00:00Z'),
  });
  const cluster = { projectId: 1, errorType: 'unknown', firstSeenRunId: 1, lastSeenRunId: 1 };
  await db.insert(schema.failureClusters).values([
    { ...cluster, id: 1, fingerprint: 'fp-1', signature: 'Error: card declined' },
    { ...cluster, id: 2, fingerprint: 'fp-2', signature: 'Error: transfer refused' },
  ]);
  await db.insert(schema.testRunsCases).values([
    { id: 10, testRunId: 1, testCaseId: 1, status: 'failed', error: 'Error: card declined', failureClusterId: 1 },
    { id: 11, testRunId: 1, testCaseId: 2, status: 'failed', error: 'Error: card declined', failureClusterId: 1 },
    { id: 12, testRunId: 1, testCaseId: 1, status: 'failed', error: 'Error: transfer refused', failureClusterId: 2 },
  ]);
  // Cluster 1 has its own diagnosis and an execution's; cluster 2 only an execution's.
  await db.insert(schema.failureDiagnoses).values([
    { clusterId: 1, scope: 'execution', testRunsCaseId: 10, status: 'completed', summary: 'One execution only' },
    { clusterId: 1, scope: 'cluster', status: 'completed', summary: 'The card form rejects test cards' },
    { clusterId: 2, scope: 'execution', testRunsCaseId: 12, status: 'completed', summary: 'One execution only' },
  ]);
});

describe('the owner in an execution detail', () => {
  test('a CODEOWNERS owner the caller resolves is named in the situation and the verdict', async () => {
    const asked: string[] = [];
    const detail = (await getTestRunCase(db as never, 10, null, {
      resolveOwner: async (filePath) => {
        asked.push(filePath);
        return '@payments';
      },
    })) as Detail | null;
    expect(asked).toEqual(['tests/checkout.spec.ts']);
    expect(detail?.verdict?.owner).toEqual({ name: '@payments', source: 'codeowners' });
    expect(detail?.situation?.text).toMatch(/Owner @payments\.$/);
  });

  test('without a resolver, a test with no annotation has no owner', async () => {
    const detail = (await getTestRunCase(db as never, 10)) as Detail | null;
    expect(detail?.verdict?.owner).toBeNull();
    expect(detail?.situation?.text).not.toContain('Owner');
  });

  test('a resolver that finds no owner leaves the sentence without one', async () => {
    const detail = (await getTestRunCase(db as never, 10, null, { resolveOwner: async () => null })) as Detail | null;
    expect(detail?.verdict?.owner).toBeNull();
    expect(detail?.situation?.text).not.toContain('Owner');
  });

  test("the test's annotation wins, and the resolver is not asked", async () => {
    const asked: string[] = [];
    const detail = (await getTestRunCase(db as never, 11, null, {
      resolveOwner: async (filePath) => {
        asked.push(filePath);
        return '@payments';
      },
    })) as Detail | null;
    expect(asked).toEqual([]);
    expect(detail?.verdict?.owner).toEqual({ name: '@checkout-team', source: 'annotation' });
    expect(detail?.situation?.text).toMatch(/Owner @checkout-team\.$/);
  });
});

describe('the diagnosis in an execution detail', () => {
  test("is the cluster's own, never an execution-scoped one on the same cluster", async () => {
    const detail = (await getTestRunCase(db as never, 10)) as Detail | null;
    expect(detail?.failureCluster?.diagnosis?.summary).toBe('The card form rejects test cards');
    const undiagnosed = (await getTestRunCase(db as never, 12)) as Detail | null;
    expect(undiagnosed?.failureCluster?.diagnosis).toBeNull();
  });
});
