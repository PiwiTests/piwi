import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { ResolvedAiRole } from '../../types/api';
import type { DbClient } from '../../server/database';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, and the similarity thresholds are read from the
// environment at module load — clear all of it before the module under test
// (and the handlers it imports) are loaded.
delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_CLUSTER_SIMILARITY_THRESHOLD;
delete process.env.PIWI_CLUSTER_SUGGEST_THRESHOLD;

const embedder = vi.hoisted(() => ({
  /** signature marker → vector the mocked embedder returns for texts containing it */
  book: new Map<string, number[]>(),
  calls: [] as string[][],
}));

const adjudicator = vi.hoisted(() => ({
  result: null as null | { merge: boolean; confidence: 'high' | 'medium' | 'low'; reason: string },
  calls: [] as unknown[][],
}));

vi.mock('../../server/utils/ai-embeddings', () => ({
  embedTexts: async (_role: unknown, texts: string[]) => {
    embedder.calls.push(texts);
    return texts.map((t) => {
      for (const [marker, vec] of embedder.book) if (t.includes(marker)) return vec;
      return [0, 0, 1];
    });
  },
}));

vi.mock('../../server/utils/cluster-adjudicate', () => ({
  adjudicateClusterPair: async (...args: unknown[]) => {
    adjudicator.calls.push(args);
    return adjudicator.result;
  },
}));

const { reconcileNewClusters } = await import('../../server/utils/cluster-reconcile');
const { embeddingModelTag } = await import('../../server/utils/cluster-similarity');

const embeddingRole: ResolvedAiRole = { provider: 'openai', apiKey: 'k', model: 'test-embed', baseUrl: null };
const reasoningRole: ResolvedAiRole = { provider: 'openai', apiKey: 'k', model: 'test-reason', baseUrl: null };
const TAG = embeddingModelTag('test-embed');

// Cosine anchors: NEAR ≈ 0.995 (auto-merge band), AMBIG ≈ 0.900 (adjudication
// band, between the 0.8 suggest and 0.92 merge defaults), FAR = 0.
const BASE = [1, 0, 0];
const NEAR = [0.99, 0.1, 0];
const AMBIG = [0.9, 0.435, 0];
const FAR = [0, 1, 0];

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let run1: number;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

async function seedRun(): Promise<number> {
  const inserted = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status: 'failed', startTime: new Date() })
    .returning({ id: schema.testRuns.id });
  return inserted[0]!.id;
}

interface ClusterSeed {
  fingerprint: string;
  signature: string;
  firstSeenRunId: number;
  selector?: string | null;
  sampleError?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
}

async function seedCluster(c: ClusterSeed): Promise<number> {
  const inserted = await db
    .insert(schema.failureClusters)
    .values({
      projectId: 1,
      fingerprint: c.fingerprint,
      signature: c.signature,
      errorType: 'assertion',
      selector: c.selector ?? null,
      sampleError: c.sampleError ?? `${c.signature}\nExpected: 1\nReceived: 2`,
      firstSeenRunId: c.firstSeenRunId,
      lastSeenRunId: c.firstSeenRunId,
      occurrences: 1,
      embedding: c.embedding ? JSON.stringify(c.embedding) : null,
      embeddingModel: c.embeddingModel ?? null,
    })
    .returning({ id: schema.failureClusters.id });
  return inserted[0]!.id;
}

beforeEach(async () => {
  embedder.book.clear();
  embedder.calls.length = 0;
  adjudicator.result = null;
  adjudicator.calls.length = 0;

  // File-backed rather than :memory: — @libsql/client gives an interactive
  // transaction (mergeFailureClusters runs one) a connection of its own, and a
  // :memory: db has only one.
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-reconcile-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
  run1 = await seedRun();
});

afterEach(async () => {
  // The native libsql binding releases the DB file handles from a V8
  // finalizer, so on Windows the file stays locked until a garbage collection
  // runs. The test scripts run with `--expose-gc`; without it, churn the
  // allocator to force a GC, then retry until the handle is released.
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

describe('reconcileNewClusters', () => {
  test('embeds fresh clusters with cleaned text and stores the tagged model', async () => {
    const run2 = await seedRun();
    embedder.book.set('boom-a', BASE);
    const id = await seedCluster({
      fingerprint: 'fp-a',
      signature: 'boom-a',
      firstSeenRunId: run2,
      sampleError:
        '\u001b[31mboom-a\u001b[39m at https://ci.example.com/build/123\n    at fn (node_modules/pw/lib/x.js:1:1)\n    at e2e/checkout.spec.ts:10:5',
    });

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole });

    expect(stats.embedded).toBe(1);
    const sent = embedder.calls.flat().join('\n');
    expect(sent).not.toContain('\u001b');
    expect(sent).not.toContain('https://ci.example.com');
    expect(sent).toContain('<URL>');
    const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, id));
    expect(row!.embeddingModel).toBe(TAG);
    expect(JSON.parse(row!.embedding!)).toEqual(BASE);
  });

  test('auto-merges a near-identical pair, re-points cases and records an alias', async () => {
    const run2 = await seedRun();
    embedder.book.set('sig-old', BASE);
    embedder.book.set('sig-new', NEAR);
    const oldId = await seedCluster({ fingerprint: 'fp-old', signature: 'sig-old', firstSeenRunId: run1 });
    const newId = await seedCluster({ fingerprint: 'fp-new', signature: 'sig-new', firstSeenRunId: run2 });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 't1' });
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: run2, testCaseId: 1, status: 'failed', failureClusterId: newId });

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole });

    expect(stats.merged).toBe(1);
    const clusters = await db.select().from(schema.failureClusters);
    expect(clusters.map((c) => c.id)).toEqual([oldId]);
    expect(clusters[0]!.occurrences).toBe(2);
    const [alias] = await db.select().from(schema.failureClusterAliases);
    expect(alias).toMatchObject({ fingerprint: 'fp-new', clusterId: oldId });
    const [caseRow] = await db.select().from(schema.testRunsCases);
    expect(caseRow!.failureClusterId).toBe(oldId);
  });

  test('never compares vectors from a different model — stale ones are re-embedded first', async () => {
    const run2 = await seedRun();
    // The STORED stale vector is identical to the fresh cluster's, so comparing
    // it as-is would auto-merge; its RE-embedded vector is orthogonal. Only the
    // re-embed keeps the two clusters apart.
    embedder.book.set('sig-stale', FAR);
    embedder.book.set('sig-fresh', BASE);
    await seedCluster({
      fingerprint: 'fp-stale',
      signature: 'sig-stale',
      firstSeenRunId: run1,
      embedding: BASE,
      embeddingModel: 'test-embed',
    });
    await seedCluster({ fingerprint: 'fp-fresh', signature: 'sig-fresh', firstSeenRunId: run2 });

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole });

    expect(stats.merged).toBe(0);
    expect(stats.embedded).toBe(2);
    const rows = await db.select().from(schema.failureClusters);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.embeddingModel).toBe(TAG);
  });

  test('backfill converges a pre-existing near-duplicate backlog without new clusters', async () => {
    embedder.book.set('sig-b1', BASE);
    embedder.book.set('sig-b2', NEAR);
    const b1 = await seedCluster({ fingerprint: 'fp-b1', signature: 'sig-b1', firstSeenRunId: run1 });
    await seedCluster({ fingerprint: 'fp-b2', signature: 'sig-b2', firstSeenRunId: run1 });
    const run2 = await seedRun();

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole });

    expect(stats.merged).toBe(1);
    const rows = await db.select().from(schema.failureClusters);
    expect(rows.map((r) => r.id)).toEqual([b1]);
  });

  test('ambiguous similarity records one embedding suggestion when no reasoning role is set', async () => {
    const run2 = await seedRun();
    embedder.book.set('sig-a', BASE);
    embedder.book.set('sig-b', AMBIG);
    const a = await seedCluster({ fingerprint: 'fp-a', signature: 'sig-a', firstSeenRunId: run1 });
    const b = await seedCluster({ fingerprint: 'fp-b', signature: 'sig-b', firstSeenRunId: run2 });

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole });

    expect(stats.merged).toBe(0);
    expect(stats.suggested).toBe(1);
    const suggestions = await db.select().from(schema.clusterMergeSuggestions);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ clusterAId: a, clusterBId: b, method: 'embedding', status: 'pending' });
  });

  test('adjudicates the ambiguous band with usage and overlap context', async () => {
    const run2 = await seedRun();
    embedder.book.set('sig-a', BASE);
    embedder.book.set('sig-b', AMBIG);
    const a = await seedCluster({
      fingerprint: 'fp-a',
      signature: 'sig-a',
      firstSeenRunId: run1,
      selector: "getByRole('button')",
    });
    const b = await seedCluster({ fingerprint: 'fp-b', signature: 'sig-b', firstSeenRunId: run2 });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'a.spec.ts', title: 'shared test' });
    await db.insert(schema.testRunsCases).values([
      { testRunId: run1, testCaseId: 1, status: 'failed', failureClusterId: a },
      { testRunId: run2, testCaseId: 1, status: 'failed', failureClusterId: b },
      { testRunId: run2, testCaseId: 1, status: 'failed', failureClusterId: a, retries: 1 },
    ]);
    adjudicator.result = { merge: true, confidence: 'high', reason: 'same cause' };

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole, reasoningRole });

    expect(stats.merged).toBe(1);
    expect(adjudicator.calls).toHaveLength(1);
    const [, first, second, overlap] = adjudicator.calls[0]! as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(first).toMatchObject({ signature: 'sig-b', totalTests: 1, totalRuns: 1 });
    expect(second).toMatchObject({
      signature: 'sig-a',
      selector: "getByRole('button')",
      totalTests: 1,
      totalRuns: 2,
    });
    expect(second.affectedTests).toEqual([{ file: 'a.spec.ts', title: 'shared test', occurrences: 2 }]);
    expect(overlap).toEqual({ sharedTests: 1, sharedRuns: 1 });
    const clusters = await db.select().from(schema.failureClusters);
    expect(clusters.map((c) => c.id)).toEqual([a]);
  });

  test('adjudicates against an already-embedded cluster outside this pass (not fresh or backfilled)', async () => {
    // X already carries a current-tag vector from an earlier pass, so it's
    // neither a fresh cluster (firstSeenRunId != run2) nor a backfill
    // candidate (backfill only selects clusters lacking a current-tag
    // vector) — getDetails() must fall back to fetching it from the DB.
    const run2 = await seedRun();
    embedder.book.set('sig-x', BASE);
    embedder.book.set('sig-y', AMBIG);
    const x = await seedCluster({
      fingerprint: 'fp-x',
      signature: 'sig-x',
      firstSeenRunId: run1,
      embedding: BASE,
      embeddingModel: TAG,
    });
    await seedCluster({ fingerprint: 'fp-y', signature: 'sig-y', firstSeenRunId: run2 });
    adjudicator.result = { merge: true, confidence: 'high', reason: 'same cause' };

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole, reasoningRole });

    expect(stats.merged).toBe(1);
    expect(adjudicator.calls).toHaveLength(1);
    // c (the pass's source, iterated from fresh/backfill) is Cluster A; the
    // pool match resolved through getDetails' DB-fallback path is Cluster B.
    const [, , second] = adjudicator.calls[0]! as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(second).toMatchObject({ signature: 'sig-x' });
    const clusters = await db.select().from(schema.failureClusters);
    expect(clusters.map((c) => c.id)).toEqual([x]);
  });

  test('a medium-confidence merge verdict records an llm suggestion instead of merging', async () => {
    const run2 = await seedRun();
    embedder.book.set('sig-a', BASE);
    embedder.book.set('sig-b', AMBIG);
    await seedCluster({ fingerprint: 'fp-a', signature: 'sig-a', firstSeenRunId: run1 });
    await seedCluster({ fingerprint: 'fp-b', signature: 'sig-b', firstSeenRunId: run2 });
    adjudicator.result = { merge: true, confidence: 'medium', reason: 'probably related' };

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole, reasoningRole });

    expect(stats.merged).toBe(0);
    expect(stats.suggested).toBe(1);
    const [suggestion] = await db.select().from(schema.clusterMergeSuggestions);
    expect(suggestion).toMatchObject({ method: 'llm', llmConfidence: 'medium', llmReason: 'probably related' });
    expect(await db.select().from(schema.failureClusters)).toHaveLength(2);
  });

  test('a pair is adjudicated at most once per pass', async () => {
    const run2 = await seedRun();
    // Both clusters are reconciliation sources (one fresh, one backfilled) and
    // each other's nearest neighbour; without pair tracking the no-merge
    // verdict would be requested twice.
    embedder.book.set('sig-a', BASE);
    embedder.book.set('sig-b', AMBIG);
    await seedCluster({ fingerprint: 'fp-a', signature: 'sig-a', firstSeenRunId: run1 });
    await seedCluster({ fingerprint: 'fp-b', signature: 'sig-b', firstSeenRunId: run2 });
    adjudicator.result = { merge: false, confidence: 'high', reason: 'different causes' };

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole, reasoningRole });

    expect(adjudicator.calls).toHaveLength(1);
    expect(stats.merged).toBe(0);
    expect(stats.suggested).toBe(0);
    const suggestions = await db.select().from(schema.clusterMergeSuggestions);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ method: 'llm', status: 'declined', llmReason: 'different causes' });
  });

  test('a pair the adjudicator declined is not judged again on a later pass', async () => {
    const run2 = await seedRun();
    embedder.book.set('sig-a', BASE);
    embedder.book.set('sig-b', AMBIG);
    await seedCluster({ fingerprint: 'fp-a', signature: 'sig-a', firstSeenRunId: run1 });
    const b = await seedCluster({ fingerprint: 'fp-b', signature: 'sig-b', firstSeenRunId: run2 });
    adjudicator.result = { merge: false, confidence: 'high', reason: 'different causes' };
    await reconcileNewClusters(dbc, 1, run2, { embeddingRole, reasoningRole });

    // A refreshed exemplar drops the vector, so the next pass re-embeds the cluster and meets the pair again.
    await db.update(schema.failureClusters).set({ embedding: null }).where(eq(schema.failureClusters.id, b));
    const run3 = await seedRun();
    adjudicator.result = { merge: true, confidence: 'high', reason: 'same cause' };
    const stats = await reconcileNewClusters(dbc, 1, run3, { embeddingRole, reasoningRole });

    expect(adjudicator.calls).toHaveLength(1);
    expect(stats.merged).toBe(0);
    expect(await db.select().from(schema.failureClusters)).toHaveLength(2);
  });

  test('a rejected pair is never auto-merged, however similar', async () => {
    const run2 = await seedRun();
    embedder.book.set('sig-old', BASE);
    embedder.book.set('sig-new', NEAR);
    const oldId = await seedCluster({ fingerprint: 'fp-old', signature: 'sig-old', firstSeenRunId: run1 });
    const newId = await seedCluster({ fingerprint: 'fp-new', signature: 'sig-new', firstSeenRunId: run2 });
    await db.insert(schema.clusterMergeSuggestions).values({
      projectId: 1,
      clusterAId: oldId,
      clusterBId: newId,
      method: 'embedding',
      status: 'rejected',
    });

    const stats = await reconcileNewClusters(dbc, 1, run2, { embeddingRole, reasoningRole });

    expect(stats.merged).toBe(0);
    expect(adjudicator.calls).toHaveLength(0);
    expect(await db.select().from(schema.failureClusters)).toHaveLength(2);
  });
});
