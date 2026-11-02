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
const { computeErrorFingerprint } = await import('../../shared/error-fingerprint');

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

// A raw error whose signature/type differ enough that its fingerprint is not
// the one produced by `laterError`.
const originalError = "Error: expect(locator).toHaveText(expected) failed\nExpected: 'Welcome'\nReceived: 'Loading'";
const laterError = 'TimeoutError: Timeout 30000ms exceeded waiting for getByRole("button")';

async function seedCluster(values: {
  fingerprint: string;
  sampleError: string | null;
  fingerprintSample: string | null;
}): Promise<number> {
  const inserted = await db
    .insert(schema.failureClusters)
    .values({
      projectId: 1,
      fingerprint: values.fingerprint,
      signature: 'seed signature',
      errorType: 'assertion',
      selector: null,
      sampleError: values.sampleError,
      fingerprintSample: values.fingerprintSample,
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      occurrences: 1,
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
  test("gives an alias the error of its cluster whose fingerprint is the alias's", async () => {
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
    const victimFingerprint = (await computeErrorFingerprint(victimError)).fingerprint;
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
