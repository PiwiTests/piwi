import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

delete process.env.PIWI_DATABASE_URL;

const { assignFailureClusters, getOrCreateFailureClusters, mergeFailureClusters } =
  await import('../../shared/handlers/failure-cluster-ops');
const { extractClusterCases } = await import('../../shared/handlers/failure-clusters');
const { reclusterFailureFingerprints } = await import('../../shared/handlers/failure-cluster-recluster');
const { computeErrorFingerprint } = await import('../../shared/error-fingerprint');

const ERROR = "Error: expect(locator).toBeVisible() failed\nLocator: getByRole('button', { name: 'Pay' })";

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;
let runSeq = 0;

async function seedRun(): Promise<number> {
  const id = ++runSeq;
  await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'failed', startTime: new Date(id * 1000) });
  return id;
}

/** Ingest one run where each given test fails with ERROR, as persistRunCases does. */
async function ingestFailures(testCaseIds: number[]): Promise<Map<number, number | null>> {
  const runId = await seedRun();
  const fp = await computeErrorFingerprint(ERROR);
  const pending = new Map([[fp.fingerprint, { fp, sampleError: ERROR, count: testCaseIds.length }]]);
  const rows = testCaseIds.map((testCaseId) => ({
    testRunId: runId,
    testCaseId,
    status: 'failed',
    error: ERROR,
    failureClusterId: null as number | null,
  }));
  await assignFailureClusters(
    dbc as never,
    1,
    runId,
    pending,
    rows,
    rows.map(() => fp),
  );
  await db.insert(schema.testRunsCases).values(rows);
  return new Map(rows.map((r) => [r.testCaseId, r.failureClusterId]));
}

function readCluster(id: number) {
  return db
    .select()
    .from(schema.failureClusters)
    .where(eq(schema.failureClusters.id, id))
    .then((r) => r[0]);
}

beforeEach(async () => {
  runSeq = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-cluster-split-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
  ]);
});

afterEach(async () => {
  await client.close();
  globalThis.gc?.();
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' || attempt >= 40) throw error;
      if (!globalThis.gc) {
        const junk: Buffer[] = [];
        for (let i = 0; i < 60; i++) junk.push(Buffer.alloc(1 << 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

describe('moving tests to a new cluster', () => {
  test('creates a cluster for the moved tests and keeps the source note', async () => {
    const first = await ingestFailures([1, 2]);
    const sourceId = first.get(1)!;
    await db.update(schema.failureClusters).set({ triageNote: 'Seen on staging only.' });

    const result = await extractClusterCases(db as never, sourceId, [2], 'Different cause: the cart API.');

    expect(result).toMatchObject({ success: true, extractedCount: 1, remainingOccurrences: 1 });
    const newId = result!.clusterId!;
    expect(newId).not.toBe(sourceId);
    const created = await readCluster(newId);
    expect(created).toMatchObject({ occurrences: 1, triageNote: 'Different cause: the cart API.', status: 'open' });
    const source = await readCluster(sourceId);
    expect(source!.triageNote).toBe(`Seen on staging only.\nMoved 1 test to cluster #${newId}.`);
    const moved = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testCaseId, 2));
    expect(moved.map((r) => r.failureClusterId)).toEqual([newId]);
  });

  test('later failures of a moved test join the new cluster, the others the source', async () => {
    const sourceId = (await ingestFailures([1, 2])).get(1)!;
    const newId = (await extractClusterCases(db as never, sourceId, [2]))!.clusterId!;

    const next = await ingestFailures([1, 2]);

    expect(next.get(1)).toBe(sourceId);
    expect(next.get(2)).toBe(newId);
    expect(await readCluster(sourceId)).toMatchObject({ occurrences: 2, lastSeenRunId: 2 });
    expect(await readCluster(newId)).toMatchObject({ occurrences: 2, lastSeenRunId: 2 });
  });

  test('a run where only moved tests fail leaves the source cluster untouched', async () => {
    const sourceId = (await ingestFailures([1, 2])).get(1)!;
    const newId = (await extractClusterCases(db as never, sourceId, [2]))!.clusterId!;

    const next = await ingestFailures([2]);

    expect(next.get(2)).toBe(newId);
    expect(await readCluster(sourceId)).toMatchObject({ occurrences: 1, lastSeenRunId: 1 });
  });

  test('the pair is recorded as rejected, and re-fingerprinting keeps the two apart', async () => {
    const sourceId = (await ingestFailures([1, 2])).get(1)!;
    const newId = (await extractClusterCases(db as never, sourceId, [2]))!.clusterId!;

    const [pair] = await db.select().from(schema.clusterMergeSuggestions);
    expect(pair).toMatchObject({ clusterAId: sourceId, clusterBId: newId, method: 'split', status: 'rejected' });

    await reclusterFailureFingerprints(db as never);
    expect(await readCluster(newId)).toBeDefined();
    expect((await ingestFailures([2])).get(2)).toBe(newId);
  });

  test('routes follow a merge of the new cluster', async () => {
    const sourceId = (await ingestFailures([1, 2])).get(1)!;
    const newId = (await extractClusterCases(db as never, sourceId, [2]))!.clusterId!;
    const fp = await computeErrorFingerprint('Error: something else entirely');
    const other = await getOrCreateFailureClusters(
      dbc as never,
      1,
      await seedRun(),
      new Map([[fp.fingerprint, { fp, sampleError: 'Error: something else entirely', count: 1 }]]),
    );
    const otherId = other.get(fp.fingerprint)!;

    await mergeFailureClusters(dbc as never, otherId, newId);

    expect((await ingestFailures([2])).get(2)).toBe(otherId);
  });

  test('returns no cluster when none of the tests failed in the source', async () => {
    const sourceId = (await ingestFailures([1])).get(1)!;

    const result = await extractClusterCases(db as never, sourceId, [2]);

    expect(result).toMatchObject({ success: true, extractedCount: 0, clusterId: null });
    expect(await db.select().from(schema.failureClusters)).toHaveLength(1);
  });
});
