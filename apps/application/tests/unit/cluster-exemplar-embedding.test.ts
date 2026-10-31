import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { ResolvedAiRole } from '../../types/api';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_CLUSTER_SIMILARITY_THRESHOLD;
delete process.env.PIWI_CLUSTER_SUGGEST_THRESHOLD;

const embedder = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock('../../server/utils/ai-embeddings', () => ({
  embedTexts: async (_role: unknown, texts: string[]) => {
    embedder.calls.push(texts);
    return texts.map(() => [1, 0, 0]);
  },
}));

const { getOrCreateFailureClusters } = await import('../../shared/handlers/failure-cluster-ops');
const { computeErrorFingerprint } = await import('../../shared/error-fingerprint');
const { reconcileNewClusters } = await import('../../server/utils/cluster-reconcile');
const { embeddingModelTag } = await import('../../server/utils/cluster-similarity');

const embeddingRole: ResolvedAiRole = { provider: 'openai', apiKey: 'k', model: 'test-embed', baseUrl: null };
const TAG = embeddingModelTag('test-embed');

const HEAD = ['Error: expect(locator).toBeEnabled() failed', 'Expected: enabled', 'Received: disabled'].join('\n');
const plainError = `${HEAD}\n    at checkout.spec.ts:42:10`;
const richError = `${HEAD}\n\nCall log:\n  - waiting for the button\n  - element is not enabled\n    at checkout.spec.ts:42:10`;

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

async function pendingFor(error: string) {
  const fp = await computeErrorFingerprint(error);
  return { map: new Map([[fp.fingerprint, { fp, sampleError: error, count: 1 }]]), fp };
}

beforeEach(async () => {
  embedder.calls.length = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-exemplar-embed-'));
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

describe('exemplar refresh invalidates the embedding', () => {
  test('a refreshed cluster is re-embedded from the new sample by the reconciler backfill', async () => {
    // Create the cluster and give it a vector in the current model space.
    const created = await pendingFor(plainError);
    const ids = await getOrCreateFailureClusters(dbc, 1, 100, created.map);
    const clusterId = ids.get(created.fp.fingerprint)!;
    await db
      .update(schema.failureClusters)
      .set({ embedding: JSON.stringify([0, 1, 0]), embeddingModel: TAG })
      .where(eq(schema.failureClusters.id, clusterId));

    // Re-hit with a richer occurrence in a later run — refresh clears the vector.
    const better = await pendingFor(richError);
    await getOrCreateFailureClusters(dbc, 1, 200, better.map);
    const [afterRefresh] = await db
      .select({ embedding: schema.failureClusters.embedding, embeddingModel: schema.failureClusters.embeddingModel })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, clusterId));
    expect(afterRefresh!.embedding).toBeNull();
    // embeddingModel is left untouched; the null embedding alone marks the cluster stale.
    expect(afterRefresh!.embeddingModel).toBe(TAG);

    // The next post-run reconcile picks it up via its backfill and re-embeds it
    // from the new sample (run 300 ≠ the cluster's firstSeenRunId, so it's backfill).
    await reconcileNewClusters(dbc, 1, 300, { embeddingRole });

    const embeddedTexts = embedder.calls.flat();
    expect(embeddedTexts.some((t) => t.includes('element is not enabled'))).toBe(true);

    const [afterReconcile] = await db
      .select({ embedding: schema.failureClusters.embedding, embeddingModel: schema.failureClusters.embeddingModel })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, clusterId));
    expect(afterReconcile!.embedding).not.toBeNull();
    expect(afterReconcile!.embeddingModel).toBe(TAG);
  });
});
