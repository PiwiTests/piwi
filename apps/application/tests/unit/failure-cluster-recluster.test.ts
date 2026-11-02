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

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before the modules under test are loaded so they bind to SQLite.
delete process.env.PIWI_DATABASE_URL;

const { backfillAliasSamples, reclusterFailureFingerprints } =
  await import('../../shared/handlers/failure-cluster-recluster');
const { assignFailureClusters } = await import('../../shared/handlers/failure-cluster-ops');
const { computeErrorFingerprint } = await import('../../shared/error-fingerprint');
const { errorFingerprintV4 } = await import('../../shared/error-fingerprint-v4');

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

// A raw error whose signature/type differ enough that its fingerprint is not
// the one produced by `laterError`.
const originalError = "Error: expect(locator).toHaveText(expected) failed\nExpected: 'Welcome'\nReceived: 'Loading'";
const laterError = 'TimeoutError: Timeout 30000ms exceeded waiting for getByRole("button")';

async function seedCluster(
  values: {
    fingerprint: string;
    sampleError: string | null;
    fingerprintSample: string | null;
  } & Partial<typeof schema.failureClusters.$inferInsert>,
): Promise<number> {
  const inserted = await db
    .insert(schema.failureClusters)
    .values({
      projectId: 1,
      signature: 'seed signature',
      errorType: 'assertion',
      selector: null,
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      occurrences: 1,
      ...values,
    })
    .returning({ id: schema.failureClusters.id });
  return inserted[0]!.id;
}

beforeEach(async () => {
  // A file database: libSQL runs a transaction on its own connection, which an
  // in-memory database does not share.
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-recluster-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
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

describe('reclusterFailureFingerprints', () => {
  test('re-fingerprints from fingerprintSample, not the refreshed sampleError', async () => {
    // The display sample has drifted to a later, differently-shaped occurrence
    // while the frozen fingerprint source still holds the original error.
    const fromSample = await computeErrorFingerprint(originalError);
    const fromLater = await computeErrorFingerprint(laterError);
    expect(fromSample.fingerprint).not.toBe(fromLater.fingerprint);

    const id = await seedCluster({
      fingerprint: 'stale-fp', // forces a rewrite regardless of algorithm version
      sampleError: laterError,
      fingerprintSample: originalError,
    });

    const stats = await reclusterFailureFingerprints(dbc);
    expect(stats.updated).toBe(1);

    const [row] = await db
      .select({ fingerprint: schema.failureClusters.fingerprint, signature: schema.failureClusters.signature })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, id));
    // Fingerprint came from fingerprintSample (originalError), not sampleError.
    expect(row!.fingerprint).toBe(fromSample.fingerprint);
    expect(row!.fingerprint).not.toBe(fromLater.fingerprint);
    expect(row!.signature).toBe(fromSample.signature);
  });

  test('falls back to sampleError when fingerprintSample is null (legacy rows)', async () => {
    const fromSample = await computeErrorFingerprint(originalError);

    const id = await seedCluster({
      fingerprint: 'stale-fp',
      sampleError: originalError,
      fingerprintSample: null,
    });

    const stats = await reclusterFailureFingerprints(dbc);
    expect(stats.updated).toBe(1);

    const [row] = await db
      .select({ fingerprint: schema.failureClusters.fingerprint })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, id));
    expect(row!.fingerprint).toBe(fromSample.fingerprint);
  });
});

describe('backfillAliasSamples', () => {
  test("gives an alias the error of its cluster whose version 4 fingerprint is the alias's", async () => {
    const victimError =
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('pay')";
    const id = await seedCluster({
      fingerprint: (await computeErrorFingerprint(originalError)).fingerprint,
      sampleError: originalError,
      fingerprintSample: originalError,
    });
    // The executions of the cluster merged into it, which the merge moved to the survivor.
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' });
    await db.insert(schema.testRunsCases).values(
      [originalError, victimError].map((error, retries) => ({
        testRunId: 1,
        testCaseId: 1,
        status: 'failed',
        retries,
        error,
        failureClusterId: id,
      })),
    );
    // The last version whose aliases kept no sample wrote it.
    const victimFingerprint = await errorFingerprintV4(victimError);
    expect(victimFingerprint).not.toBe((await computeErrorFingerprint(victimError)).fingerprint);
    await db.insert(schema.failureClusterAliases).values([
      { projectId: 1, fingerprint: victimFingerprint, clusterId: id },
      { projectId: 1, fingerprint: 'fingerprint-no-error-has', clusterId: id },
    ]);

    expect(await backfillAliasSamples(dbc)).toBe(1);

    const aliases = await db
      .select({
        fingerprint: schema.failureClusterAliases.fingerprint,
        fingerprintSample: schema.failureClusterAliases.fingerprintSample,
      })
      .from(schema.failureClusterAliases)
      .orderBy(schema.failureClusterAliases.id);
    expect(aliases).toEqual([
      { fingerprint: victimFingerprint, fingerprintSample: victimError },
      { fingerprint: 'fingerprint-no-error-has', fingerprintSample: null },
    ]);
  });
});

describe('a fingerprint version bump', () => {
  // Fingerprints the previous version computed: no error has them any more.
  const STALE_A = 'previous-version-fingerprint-a';
  const STALE_B = 'previous-version-fingerprint-b';

  async function seedRun(id: number, startTime: Date) {
    await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'failed', startTime });
  }

  /** The cluster test `testCaseId` joins when it fails with `error` in run `runId`, as ingest assigns it. */
  async function clusterJoined(testCaseId: number, error: string, runId: number): Promise<number | null> {
    const fp = await computeErrorFingerprint(error);
    const rows = [{ testCaseId, failureClusterId: null as number | null }];
    await assignFailureClusters(
      dbc as never,
      1,
      runId,
      new Map([[fp.fingerprint, { fp, sampleError: error, count: 1 }]]),
      rows,
      [fp],
    );
    return rows[0]!.failureClusterId;
  }

  beforeEach(async () => {
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'tests/welcome.spec.ts', title: 'greets' },
      { id: 2, projectId: 1, filePath: 'tests/welcome.spec.ts', title: 'greets again' },
    ]);
  });

  test('computes the aliases and the per-test routes again, so a merge and a move keep holding', async () => {
    await seedRun(1, new Date('2026-10-01T10:00:00Z'));
    // Under the previous version, cluster A absorbed the cluster of `laterError`, then test 2 moved out of A.
    const a = await seedCluster({ fingerprint: STALE_A, sampleError: originalError, fingerprintSample: originalError });
    const moved = await seedCluster({
      fingerprint: 'split:moved',
      sampleError: originalError,
      fingerprintSample: null,
    });
    await db
      .insert(schema.failureClusterAliases)
      .values({ projectId: 1, fingerprint: STALE_B, fingerprintSample: laterError, clusterId: a });
    await db
      .insert(schema.failureClusterTestRoutes)
      .values(
        [STALE_A, STALE_B].map((fingerprint) => ({ projectId: 1, fingerprint, testCaseId: 2, clusterId: moved })),
      );

    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 2, merged: 0 });

    const fpA = (await computeErrorFingerprint(originalError)).fingerprint;
    const fpB = (await computeErrorFingerprint(laterError)).fingerprint;
    const aliases = await db
      .select({
        fingerprint: schema.failureClusterAliases.fingerprint,
        clusterId: schema.failureClusterAliases.clusterId,
      })
      .from(schema.failureClusterAliases);
    expect(aliases).toEqual([{ fingerprint: fpB, clusterId: a }]);
    const routes = await db
      .select({ fingerprint: schema.failureClusterTestRoutes.fingerprint })
      .from(schema.failureClusterTestRoutes);
    expect(routes.map((r) => r.fingerprint).sort()).toEqual([fpA, fpB].sort());

    expect(await clusterJoined(1, laterError, 1)).toBe(a);
    expect(await clusterJoined(2, laterError, 1)).toBe(moved);
    expect(await clusterJoined(2, originalError, 1)).toBe(moved);
    expect(await db.$count(schema.failureClusters)).toBe(2);
    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 0, merged: 0 });
  });

  test('merges the clusters an alias and a cluster both lead to, the one first seen earlier keeping its triage', async () => {
    await seedRun(1, new Date('2026-10-01T10:00:00Z'));
    await seedRun(2, new Date('2026-10-02T10:00:00Z'));
    // A absorbed `laterError` under the previous version; B, imported from an earlier run, holds it under this one.
    const a = await seedCluster({
      fingerprint: STALE_A,
      sampleError: originalError,
      fingerprintSample: originalError,
      firstSeenRunId: 2,
      lastSeenRunId: 2,
      status: 'ignored',
      triageNote: 'Seen on staging only.',
    });
    const b = await seedCluster({
      fingerprint: (await computeErrorFingerprint(laterError)).fingerprint,
      sampleError: laterError,
      fingerprintSample: laterError,
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      status: 'resolved',
      assignee: 'ada',
      triageNote: 'Fixed by the cart refactor',
    });
    await db
      .insert(schema.failureClusterAliases)
      .values({ projectId: 1, fingerprint: STALE_B, fingerprintSample: laterError, clusterId: a });

    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 2, merged: 1 });

    const clusters = await db
      .select({
        id: schema.failureClusters.id,
        status: schema.failureClusters.status,
        assignee: schema.failureClusters.assignee,
        triageNote: schema.failureClusters.triageNote,
      })
      .from(schema.failureClusters);
    expect(clusters).toEqual([
      { id: b, status: 'resolved', assignee: 'ada', triageNote: 'Fixed by the cart refactor\nSeen on staging only.' },
    ]);
    expect(await clusterJoined(1, originalError, 2)).toBe(b);
    expect(await clusterJoined(1, laterError, 2)).toBe(b);
    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 0, merged: 0 });
  });

  test('keeps a merge version 4 recorded without a sample, once the backfill found it', async () => {
    await seedRun(1, new Date('2026-10-01T10:00:00Z'));
    // Version 4 merged the cluster of `laterError` into A: A holds its executions, the alias no sample.
    const a = await seedCluster({
      fingerprint: await errorFingerprintV4(originalError),
      sampleError: originalError,
      fingerprintSample: originalError,
    });
    await db.insert(schema.testRunsCases).values(
      [originalError, laterError].map((error, i) => ({
        testRunId: 1,
        testCaseId: i + 1,
        status: 'failed',
        error,
        failureClusterId: a,
      })),
    );
    await db
      .insert(schema.failureClusterAliases)
      .values({ projectId: 1, fingerprint: await errorFingerprintV4(laterError), clusterId: a });

    expect(await backfillAliasSamples(dbc)).toBe(1);
    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 2, merged: 0 });

    expect(await clusterJoined(2, laterError, 1)).toBe(a);
    expect(await clusterJoined(1, originalError, 1)).toBe(a);
    expect(await db.$count(schema.failureClusters)).toBe(1);
  });

  test('leaves the moment a cluster was triaged, which the analytics read as when it was resolved', async () => {
    const resolvedAt = new Date('2026-09-01T10:00:00Z');
    const id = await seedCluster({
      fingerprint: STALE_A,
      sampleError: originalError,
      fingerprintSample: originalError,
      status: 'resolved',
      updatedAt: resolvedAt,
    });

    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 1, merged: 0 });

    const [row] = await db
      .select({ updatedAt: schema.failureClusters.updatedAt })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, id));
    expect(row!.updatedAt).toEqual(resolvedAt);
  });

  test('merges two clusters whose samples now share a fingerprint into the one first seen earlier', async () => {
    await seedRun(1, new Date('2026-10-01T10:00:00Z'));
    await seedRun(2, new Date('2026-10-02T10:00:00Z'));
    await seedCluster({
      fingerprint: STALE_A,
      sampleError: originalError,
      fingerprintSample: originalError,
      firstSeenRunId: 2,
    });
    const older = await seedCluster({
      fingerprint: STALE_B,
      sampleError: originalError,
      fingerprintSample: originalError,
      firstSeenRunId: 1,
      triageNote: 'Known since the import.',
    });

    expect(await reclusterFailureFingerprints(dbc)).toEqual({ updated: 2, merged: 1 });

    const clusters = await db
      .select({
        id: schema.failureClusters.id,
        fingerprint: schema.failureClusters.fingerprint,
        triageNote: schema.failureClusters.triageNote,
      })
      .from(schema.failureClusters);
    expect(clusters).toEqual([
      {
        id: older,
        fingerprint: (await computeErrorFingerprint(originalError)).fingerprint,
        triageNote: 'Known since the import.',
      },
    ]);
    expect(await db.$count(schema.failureClusterAliases)).toBe(0);
  });
});
