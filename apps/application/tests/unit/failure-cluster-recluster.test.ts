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

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before the modules under test are loaded so they bind to SQLite.
delete process.env.PIWI_DATABASE_URL;

const { reclusterFailureFingerprints } = await import('../../shared/handlers/failure-cluster-recluster');
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
