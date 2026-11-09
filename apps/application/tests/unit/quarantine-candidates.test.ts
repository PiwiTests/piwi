import { describe, test, expect, beforeEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * Quarantine candidates: the flaky analysis proposes the expensive tests, and
 * a high-confidence AI diagnosis calling one of them flaky adds a reason.
 */

const flaky = vi.hoisted(() => ({ tests: [] as Array<Record<string, unknown>> }));

vi.mock('#shared/handlers/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/handlers/projects')>()),
  getProjectFlakyTests: async () => flaky.tests,
}));

delete process.env.PIWI_DATABASE_URL;
const { proposeQuarantineCandidates } = await import('../../server/utils/quarantine-candidates');

let db: ReturnType<typeof drizzle<typeof schema>>;

const flakyTest = (testCaseId: number) => ({
  testCaseId,
  title: `test ${testCaseId}`,
  filePath: 'tests/cart.spec.ts',
  score: 60,
  wastedCiMinutes: 4,
  rootCause: 'timing',
  owner: null,
});

async function diagnose(clusterId: number, values: Partial<typeof schema.failureDiagnoses.$inferInsert>) {
  await db.insert(schema.failureDiagnoses).values({
    clusterId,
    scope: 'cluster',
    status: 'completed',
    provider: 'openai',
    model: 'm',
    category: 'flaky-test',
    confidence: 'high',
    summary: 'The cart total races the price refresh',
    ...values,
  });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  const cluster = { projectId: 1, errorType: 'assertion', firstSeenRunId: 1, lastSeenRunId: 1 };
  await db
    .insert(schema.failureClusters)
    .values([1, 2, 3, 4].map((id) => ({ ...cluster, id, fingerprint: `f${id}`, signature: `s${id}` })));
  await db
    .insert(schema.testCases)
    .values([1, 2, 3, 4].map((id) => ({ id, projectId: 1, filePath: 'tests/cart.spec.ts', title: `test ${id}` })));
  // Each test failed once, into the cluster of the same id.
  await db
    .insert(schema.testRunsCases)
    .values([1, 2, 3, 4].map((id) => ({ testRunId: 1, testCaseId: id, status: 'failed', failureClusterId: id })));
  flaky.tests = [1, 2, 3, 4].map(flakyTest);
});

describe('proposeQuarantineCandidates', () => {
  test('a high-confidence flaky-test diagnosis becomes one of the reasons', async () => {
    await diagnose(1, {});
    const [candidate] = await proposeQuarantineCandidates(db as unknown as DbClient, 1, new Set());

    expect(candidate!.reasons).toEqual([
      'Flaky score 60, wasting ~4.0 CI minutes (timing)',
      'AI diagnosis, high confidence: a flaky test (The cart total races the price refresh)',
    ]);
    expect(candidate!.rationale).toBe(candidate!.reasons.join('; '));
    expect(candidate!.diagnosis).toEqual({
      clusterId: 1,
      summary: 'The cart total races the price refresh',
      model: 'm',
    });
  });

  test('a diagnosis of lower confidence, another category or rated unhelpful adds nothing', async () => {
    await diagnose(2, { confidence: 'medium' });
    await diagnose(3, { category: 'app-bug' });
    await diagnose(4, { feedback: 'down' });
    const candidates = await proposeQuarantineCandidates(db as unknown as DbClient, 1, new Set([1]));

    expect(candidates.map((c) => c.testCaseId)).toEqual([2, 3, 4]);
    for (const c of candidates) {
      expect(c.reasons).toHaveLength(1);
      expect(c.diagnosis).toBeNull();
    }
  });
});
