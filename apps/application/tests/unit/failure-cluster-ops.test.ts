import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

delete process.env.PIWI_DATABASE_URL;

const { getOrCreateFailureClusters } = await import('../../shared/handlers/failure-cluster-ops');
const { computeErrorFingerprint } = await import('../../shared/error-fingerprint');

// The call log and the stack are excluded from the fingerprint (extractMessageHead
// stops at them), so these two errors share a fingerprint while differing as
// display exemplars: `richError` carries a Call log, `plainError` does not.
const HEAD = [
  'Error: expect(locator).toBeEnabled() failed',
  "Locator: getByRole('button', { name: 'Pay' })",
  'Expected: enabled',
  'Received: disabled',
].join('\n');
const plainError = `${HEAD}\n    at checkout.spec.ts:42:10`;
const richError = `${HEAD}\n\nCall log:\n  - waiting for the button to be enabled\n  - element is not enabled\n    at checkout.spec.ts:42:10`;

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

async function pendingFor(error: string) {
  const fp = await computeErrorFingerprint(error);
  return { map: new Map([[fp.fingerprint, { fp, sampleError: error, count: 1 }]]), fp };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-cluster-ops-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
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

function readCluster(id: number) {
  return db
    .select({
      fingerprint: schema.failureClusters.fingerprint,
      fingerprintSample: schema.failureClusters.fingerprintSample,
      sampleError: schema.failureClusters.sampleError,
      signature: schema.failureClusters.signature,
      occurrences: schema.failureClusters.occurrences,
      lastSeenRunId: schema.failureClusters.lastSeenRunId,
      firstSeenRunId: schema.failureClusters.firstSeenRunId,
    })
    .from(schema.failureClusters)
    .where(eq(schema.failureClusters.id, id))
    .then((r) => r[0]!);
}

describe('getOrCreateFailureClusters exemplar refresh', () => {
  test('seeds fingerprintSample from the creation error', async () => {
    const { map, fp } = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, map);
    const row = await readCluster(ids.get(fp.fingerprint)!);
    expect(row.sampleError).toBe(plainError);
    expect(row.fingerprintSample).toBe(plainError);
    expect(row.occurrences).toBe(1);
  });

  test('refreshes the display exemplar when a better occurrence recurs, leaving the fingerprint source frozen', async () => {
    const created = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, created.map);
    const clusterId = ids.get(created.fp.fingerprint)!;

    const better = await pendingFor(richError);
    // Same root cause ⇒ same fingerprint ⇒ same cluster.
    expect(better.fp.fingerprint).toBe(created.fp.fingerprint);

    await getOrCreateFailureClusters(dbc, 1, 200, better.map);
    const row = await readCluster(clusterId);

    // Display sample moved to the richer occurrence…
    expect(row.sampleError).toBe(richError);
    // …but the fingerprint source and the fingerprint itself did not.
    expect(row.fingerprintSample).toBe(plainError);
    expect(row.fingerprint).toBe(created.fp.fingerprint);
    expect(row.occurrences).toBe(2);
    expect(row.lastSeenRunId).toBe(200);
  });

  test('keeps the current exemplar for an equal-or-worse occurrence (stability), still counting it', async () => {
    const created = await pendingFor(richError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, created.map);
    const clusterId = ids.get(created.fp.fingerprint)!;

    const worse = await pendingFor(plainError);
    await getOrCreateFailureClusters(dbc, 1, 200, worse.map);
    const row = await readCluster(clusterId);

    expect(row.sampleError).toBe(richError); // unchanged — the current one is better
    expect(row.fingerprintSample).toBe(richError);
    expect(row.occurrences).toBe(2); // still counted
    expect(row.lastSeenRunId).toBe(200);
  });
});

describe('getOrCreateFailureClusters first and last seen runs', () => {
  const run = (id: number, startTime: string) => ({
    id,
    projectId: 1,
    status: 'failed',
    startTime: new Date(startTime),
  });

  test('a run imported from the past moves the first seen run back and leaves the last seen run', async () => {
    await db
      .insert(schema.testRuns)
      .values([run(10, '2026-10-01T10:00:00Z'), run(11, '2026-10-17T10:00:00Z'), run(12, '2026-08-01T10:00:00Z')]);
    const { map, fp } = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 10, map);
    const clusterId = ids.get(fp.fingerprint)!;

    await getOrCreateFailureClusters(dbc, 1, 11, (await pendingFor(plainError)).map);
    expect(await readCluster(clusterId)).toMatchObject({ firstSeenRunId: 10, lastSeenRunId: 11 });

    // Run 12 has a higher id but started two months earlier.
    await getOrCreateFailureClusters(dbc, 1, 12, (await pendingFor(plainError)).map);
    expect(await readCluster(clusterId)).toMatchObject({ firstSeenRunId: 12, lastSeenRunId: 11, occurrences: 3 });
  });
});
